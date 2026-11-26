// Replacing, clearing and destroying from inside the request handler and the
// file drop handler, against a real webview. One scenario per process (the
// name is argv[2]); prints one line `RESULT <json>`. Run by
// test/request-handler.test.ts in a child process with a timeout, so a
// teardown that hangs fails the test instead of the run.
//
// The request handler runs inside WebView2's WebResourceRequested (Windows)
// or a WKURLSchemeHandler (macOS); the file drop handler is called through
// its native pointer from inside a binding, so it too runs while
// webview_run is on the stack.
import { CFunction, FFIType } from "bun:ffi";
import { encodeCString } from "../../src/ffi";
import {
  fileDropCallbackPtr,
  pendingCallbackCloses,
} from "../../src/internal-test-hooks";
import { Webview, WebviewError } from "../../src/index";

const scenario = process.argv[2];
const webview = new Webview(false, { width: 400, height: 300, hint: 0 });
if (!webview.unsafeHandle) {
  throw new Error("webview_create returned null");
}
const report: Record<string, unknown> = { scenario };

// What fn throws: a WebviewError's code, or a description.
function codeOf(fn: () => void): number | string {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return e instanceof WebviewError ? e.code : String(e);
  }
}

// Every API a handler might reach for once the webview is destroyed.
function afterDestroyCodes() {
  return {
    completeRequest: codeOf(() => webview.completeRequest(1n, {})),
    setRequestHandler: codeOf(() => webview.setRequestHandler(null)),
    setFileDropHandler: codeOf(() => webview.setFileDropHandler(null)),
  };
}

function finish() {
  webview.destroy();
}

// A page that fetches each path in order, reports the statuses and bodies,
// and then calls `done` (unless the webview is gone by then).
function pageFetching(paths: string[]) {
  return `<!doctype html><html><body><script>
(async () => {
  const r = [];
  for (const p of ${JSON.stringify(paths)}) {
    try {
      const resp = await fetch(p);
      r.push({ path: p, status: resp.status, body: await resp.text() });
    } catch (e) {
      r.push({ path: p, error: String(e) });
    }
  }
  window.done(JSON.stringify(r));
})();
</script></body></html>`;
}

if (scenario === "request-replace-clear") {
  // /a: handler A replaces itself with B and answers. /b: B clears itself
  // and answers. /c: no handler, so 404.
  const html = pageFetching(["/a", "/b", "/c"]);
  const calls: string[] = [];
  const handlerB = (req: { url: string }) => {
    const path = new URL(req.url).pathname;
    calls.push(`B${path}`);
    if (path === "/b") {
      webview.setRequestHandler(null);
      report.pendingAfterClearInsideCall = pendingCallbackCloses();
      return { body: "from-B" };
    }
    return { status: 500 };
  };
  webview.setRequestHandler((req) => {
    const path = new URL(req.url).pathname;
    calls.push(`A${path}`);
    if (path === "/index.html") {
      return {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: html,
      };
    }
    if (path === "/a") {
      webview.setRequestHandler(handlerB);
      report.pendingAfterReplaceInsideCall = pendingCallbackCloses();
      return { body: "from-A" };
    }
    return { status: 500 };
  });
  webview.bind("done", (json: string) => {
    report.page = JSON.parse(json);
    report.calls = calls;
    finish();
  });
  webview.navigate(`${webview.assetOrigin}/index.html`);
  webview.run();
} else if (scenario === "request-destroy") {
  // /destroy: the handler destroys the webview from inside
  // WebResourceRequested. run() must return and the process exit.
  const html = pageFetching(["/destroy", "/after"]);
  let destroyed = false;
  let callsAfterDestroy = 0;
  webview.setRequestHandler((req) => {
    if (destroyed) {
      callsAfterDestroy++;
      return { status: 500 };
    }
    const path = new URL(req.url).pathname;
    if (path === "/index.html") {
      return {
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: html,
      };
    }
    if (path === "/destroy") {
      destroyed = true;
      webview.destroy();
      report.destroyedInsideCall = true;
      report.insideCall = afterDestroyCodes();
      // Ignored: the webview is gone, and webview_destroy releases the
      // request unanswered.
      return { body: "too late" };
    }
    return { status: 404 };
  });
  webview.bind("done", () => {
    report.pageFinished = true; // never: the webview is gone first
    finish();
  });
  webview.navigate(`${webview.assetOrigin}/index.html`);
  webview.run();
  report.runReturned = true;
  report.callsAfterDestroy = callsAfterDestroy;
  report.afterRun = afterDestroyCodes();
} else if (scenario === "drop-replace-clear-destroy") {
  // From inside a binding (so webview_run is on the stack), the file drop
  // handler is called through its native pointer: A replaces itself with B,
  // B clears itself, C destroys the webview.
  const drops: string[] = [];
  const callDrop = (paths: string[]) => {
    const ptr = fileDropCallbackPtr(webview);
    if (!ptr) return false;
    new CFunction({
      ptr,
      args: [FFIType.ptr, FFIType.ptr],
      returns: FFIType.void,
    })(encodeCString(JSON.stringify(paths)), null);
    return true;
  };
  webview.setFileDropHandler((paths) => {
    drops.push(`A:${paths.join(",")}`);
    webview.setFileDropHandler((more) => {
      drops.push(`B:${more.join(",")}`);
      webview.setFileDropHandler(null);
      report.pendingAfterClearInsideCall = pendingCallbackCloses();
    });
    report.pendingAfterReplaceInsideCall = pendingCallbackCloses();
  });
  webview.bind("drop", () => {
    report.firstCalled = callDrop(["/one"]);
    report.secondCalled = callDrop(["/two"]);
    report.ptrAfterClear = fileDropCallbackPtr(webview) === null;
    webview.setFileDropHandler((paths) => {
      drops.push(`C:${paths.join(",")}`);
      webview.destroy();
      report.insideCall = afterDestroyCodes();
    });
    report.thirdCalled = callDrop(["/three"]);
    // Destroyed, but the teardown waits for this call to return, so the
    // callback is still installed: called again, it does nothing.
    report.fourthCalled = callDrop(["/four"]);
    report.drops = drops;
    return true;
  });
  webview.setHTML(
    "<!doctype html><html><body><script>window.drop();</script></body></html>",
  );
  webview.run();
  report.runReturned = true;
  report.afterRun = afterDestroyCodes();
} else {
  throw new Error(`unknown scenario ${scenario}`);
}

// Every callback released inside a call is closed by the next turn of the
// event loop.
await new Promise((resolve) => setTimeout(resolve, 0));
report.pendingAtEnd = pendingCallbackCloses();
console.log("RESULT " + JSON.stringify(report));
process.exit(0);

// Opens a real webview, serves a page through the request handler and the
// asset table, and prints one line `RESULT <json>` with what the page saw.
// Run by test/request-handler.test.ts in a child process with a timeout.
// No sockets: every response comes from WebResourceRequested (Windows) or a
// WKURLSchemeHandler (macOS).
import { lib } from "../../src/ffi";
import {
  completeWebviewRequest,
  Webview,
  WebviewError,
  type WebviewRequest,
} from "../../src/index";

const webview = new Webview(false, { width: 800, height: 600, hint: 0 });
const handle = webview.unsafeHandle;
if (!handle) {
  throw new Error(
    "webview_create returned null (is another WebView2 using this user data folder?)",
  );
}
const origin = webview.assetOrigin;
const frames = webview.framesOrigin;

const seen: { method: string; url: string }[] = [];
const report: Record<string, unknown> = {
  assetOrigin: origin,
  framesOrigin: frames,
};

// External drop: both directions succeed (throws otherwise).
webview.setAllowExternalDrop(false);
webview.setAllowExternalDrop(true);
report.externalDrop = "ok";

// The asset table still answers first, untouched by the handler.
webview.setAsset(
  "static.js",
  "text/javascript; charset=utf-8",
  "window.staticScript = 'static-ok';",
);
webview.setAsset("asset.txt", "text/plain; charset=utf-8", "asset-text");

// Answers /api/echo and /dynamic.png on another thread, after the handler
// returned: the pattern for async work while run() blocks this thread.
const worker = new Worker(new URL("./complete-worker.ts", import.meta.url));
await new Promise<void>((resolve) => {
  worker.onmessage = (e) => {
    if (e.data === "ready") resolve();
  };
});

const page = `<!doctype html>
<html><head><meta charset="utf-8">
<script>
  window.frameMessage = new Promise((resolve) => {
    window.addEventListener("message", (e) => resolve({ eventOrigin: e.origin, data: e.data }));
  });
</script>
<script src="/static.js"></script>
</head><body>
<img id="img" src="/dynamic.png">
<iframe id="frame" src="${frames}/sandbox.html"></iframe>
<script>
(async () => {
  const r = {};
  try {
    r.parentOrigin = window.origin;
    r.staticScript = window.staticScript || null;
    r.staticFetch = await (await fetch("/asset.txt")).text();

    const resp = await fetch("/api/echo?x=1", {
      method: "POST",
      headers: { "X-Sweetview-Test": 'hello "world"', "Content-Type": "application/json" },
      body: JSON.stringify({ ping: "pong", n: 42 }),
    });
    r.echoStatus = resp.status;
    r.echoContentType = resp.headers.get("content-type");
    r.echoMulti = resp.headers.get("x-multi");
    r.echoInjected = resp.headers.get("x-injected");
    r.echoEvil = resp.headers.get("x-evil");
    r.rawRejections = resp.headers.get("x-raw-rejections");
    r.wrapperRejections = resp.headers.get("x-wrapper-rejections");
    r.echo = await resp.json();

    const img = document.getElementById("img");
    r.imgEvent = await new Promise((res) => {
      if (img.complete && img.naturalWidth) return res("load");
      img.onload = () => res("load");
      img.onerror = () => res("error");
    });
    r.img = { w: img.naturalWidth, h: img.naturalHeight };

    const msg = await window.frameMessage;
    r.frameEventOrigin = msg.eventOrigin;
    r.frameOrigin = msg.data.origin;
    r.frameHref = msg.data.href;
    try {
      r.frameDocumentAccess = typeof document.getElementById("frame").contentWindow.document;
    } catch (e) {
      r.frameDocumentAccess = "blocked:" + e.name;
    }

    r.missingStatus = (await fetch("/nothing-here")).status;

    // A service worker's own fetch must reach the handler too (WebView2:
    // the filter covers every request source kind), never the network.
    // Windows only: WebKit's ServiceWorkerContainer allows only http: and
    // https: origins, and macOS serves the page from the webview: scheme.
    if (${JSON.stringify(process.platform === "win32")}) {
      try {
        const reply = new Promise((res) => {
          navigator.serviceWorker.addEventListener("message", (e) => res(e.data));
        });
        navigator.serviceWorker.startMessages();
        const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        r.swScope = reg.scope;
        const ready = await navigator.serviceWorker.ready;
        ready.active.postMessage("go");
        r.sw = await Promise.race([
          reply,
          new Promise((res) => setTimeout(() => res({ timeout: true }), 15000)),
        ]);
      } catch (e) {
        r.sw = { error: String(e) };
      }
    }
    // Left open on purpose: destroying the webview must answer and release it.
    fetch("/never").catch(() => {});
  } catch (e) {
    r.error = String(e && e.stack || e);
  }
  window.report(JSON.stringify(r));
})();
</script>
</body></html>`;

// Fetches /from-sw from inside the service worker when the page asks, and
// sends back what it got.
const serviceWorker = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("message", (e) => {
  e.waitUntil(
    fetch("/from-sw?via=service-worker")
      .then(async (r) => ({ status: r.status, text: await r.text() }))
      .catch((err) => ({ error: String(err) }))
      .then((result) => e.source.postMessage(result)),
  );
});
`;

const sandbox = `<!doctype html><html><body>sandbox
<script>parent.postMessage({ origin: window.origin, href: location.href }, "*");</script>
</body></html>`;

webview.setRequestHandler((req: WebviewRequest) => {
  seen.push({ method: req.method, url: req.url });
  if (process.env.SV_DEBUG) console.error("handler", req.method, req.url);
  const url = new URL(req.url);
  const isFrames = url.origin === frames;
  if (isFrames && url.pathname === "/sandbox.html") {
    return {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      body: sandbox,
    };
  }
  if (!isFrames && url.pathname === "/dynamic") {
    // Answered synchronously from the handler.
    return {
      headers: [["Content-Type", "text/html; charset=utf-8"]],
      body: page,
    };
  }
  if (
    !isFrames &&
    (url.pathname === "/api/echo" || url.pathname === "/dynamic.png")
  ) {
    // Answered later, from a worker thread, through webview_complete_request.
    worker.postMessage({ handle: Number(handle), request: req });
    return;
  }
  if (!isFrames && url.pathname === "/sw.js") {
    return {
      headers: { "Content-Type": "text/javascript; charset=utf-8" },
      body: serviceWorker,
    };
  }
  if (!isFrames && url.pathname === "/from-sw") {
    return {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: "sw-ok",
    };
  }
  if (!isFrames && url.pathname === "/never") {
    // Never answered; webview_destroy answers it 503 and releases it.
    report.neverOpened = true;
    finishWhenDone();
    return;
  }
  return { status: 404, body: "not found" };
});

// Ends webview_run once the page has reported and /never is open; run() then
// destroys the webview with that request still pending.
function finishWhenDone() {
  if (report.page && report.neverOpened) {
    report.requests = seen;
    lib.symbols.webview_terminate(handle);
  }
}

webview.bind("report", (json: string) => {
  report.page = JSON.parse(json);
  finishWhenDone();
});

webview.navigate(`${origin}/dynamic`);
webview.run(); // destroys the webview when it returns

// After webview_destroy: completing against the stale handle is refused with
// WEBVIEW_ERROR_INVALID_STATE (-3), on this thread and on the worker's.
try {
  completeWebviewRequest(handle, 1n, { status: 200, body: "late" });
  report.afterDestroyMain = 0;
} catch (e) {
  report.afterDestroyMain = e instanceof WebviewError ? e.code : String(e);
}
// Webview.completeRequest after destroy() throws the same -3.
try {
  webview.completeRequest(1n, { status: 200, body: "late" });
  report.afterDestroyMethod = 0;
} catch (e) {
  report.afterDestroyMethod = e instanceof WebviewError ? e.code : String(e);
}
report.afterDestroyWorker = await new Promise((resolve) => {
  worker.onmessage = (e) => {
    if (e.data?.afterDestroy) resolve(e.data.afterDestroy);
  };
  worker.postMessage({ handle: Number(handle), afterDestroy: { id: "1" } });
});
worker.terminate();
console.log("RESULT " + JSON.stringify(report));
process.exit(0);

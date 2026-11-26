// The request handler, the frames origin and external drop, against the
// shipped library in build/. The live part opens a real webview (WebView2 on
// Windows) in a child process; nothing listens on a socket.
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeBindingError } from "../src/binding-error";
import { libraryPath } from "../src/ffi";
import {
  beginWebviewResponse,
  completeWebviewRequest,
  Webview,
  WebviewError,
  writeWebviewResponseChunk,
} from "../src/index";

describe("library exports", () => {
  test("webview_set_request_handler, webview_complete_request, webview_set_allow_external_drop", () => {
    const lib = dlopen(libraryPath, {
      webview_set_request_handler: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      webview_complete_request: {
        args: [
          FFIType.ptr,
          FFIType.u64,
          FFIType.i32,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u64,
        ],
        returns: FFIType.i32,
      },
      webview_set_allow_external_drop: {
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      webview_set_asset: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    for (const fn of Object.values(lib.symbols)) {
      expect(typeof fn).toBe("function");
    }
    // A null webview is refused, not dereferenced: WEBVIEW_ERROR_INVALID_ARGUMENT (-2).
    expect(lib.symbols.webview_set_allow_external_drop(null, 1)).toBe(-2);
    expect(lib.symbols.webview_set_request_handler(null, null, null)).toBe(-2);
    // A null webview is refused before anything else is looked at.
    expect(
      lib.symbols.webview_complete_request(null, 0n, 200, null, null, 0n),
    ).toBe(-2);
    expect(
      lib.symbols.webview_complete_request(null, 1n, 42, null, null, 0n),
    ).toBe(-2);
    // A handle that never came from webview_create (or was destroyed) is
    // looked up in the live-instance registry and refused, never
    // dereferenced: WEBVIEW_ERROR_INVALID_STATE (-3).
    expect(
      lib.symbols.webview_complete_request(
        0x1000 as unknown as Pointer,
        1n,
        200,
        null,
        null,
        0n,
      ),
    ).toBe(-3);
    lib.close();
  });

  test("webview_begin_response, webview_write_response_chunk, webview_end_response, webview_set_file_drop_handler", () => {
    const lib = dlopen(libraryPath, {
      webview_begin_response: {
        args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
      webview_write_response_chunk: {
        args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
      webview_end_response: {
        args: [FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
      webview_set_file_drop_handler: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    for (const fn of Object.values(lib.symbols)) {
      expect(typeof fn).toBe("function");
    }
    // A null webview is refused: WEBVIEW_ERROR_INVALID_ARGUMENT (-2).
    expect(lib.symbols.webview_begin_response(null, 1n, 200, null)).toBe(-2);
    expect(
      lib.symbols.webview_write_response_chunk(null, 1n, null, 0n),
    ).toBe(-2);
    expect(lib.symbols.webview_end_response(null, 1n)).toBe(-2);
    expect(lib.symbols.webview_set_file_drop_handler(null, null, null)).toBe(
      -2,
    );
    // A handle not in the live-instance registry: WEBVIEW_ERROR_INVALID_STATE (-3).
    const stale = 0x1000 as unknown as Pointer;
    expect(lib.symbols.webview_begin_response(stale, 1n, 200, null)).toBe(-3);
    expect(
      lib.symbols.webview_write_response_chunk(stale, 1n, null, 0n),
    ).toBe(-3);
    expect(lib.symbols.webview_end_response(stale, 1n)).toBe(-3);
    lib.close();
  });
});

// What fn throws: a WebviewError's function name and code.
function thrown(fn: () => void): { fn: string; code: number } | string {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return e instanceof WebviewError ? { fn: e.fn, code: e.code } : String(e);
  }
}

describe("argument checks in the bindings", () => {
  // A handle not in the live-instance registry, as after webview_destroy.
  const stale = 0x1000 as unknown as Pointer;

  test("a status that is not an integer from 100 to 599 is refused with -2 before the FFI call", () => {
    // 4294967496 wraps to 200 as a C int and 200.5 truncates to 200, so
    // both would pass the library's own range check.
    for (const status of [4294967496, 200.5, 99, 600, Number.NaN]) {
      expect(
        thrown(() => completeWebviewRequest(stale, 1n, { status })),
      ).toEqual({ fn: "webview_complete_request", code: -2 });
      expect(thrown(() => beginWebviewResponse(stale, 1n, { status }))).toEqual(
        { fn: "webview_begin_response", code: -2 },
      );
    }
  });

  test("setBackgroundColor refuses a channel that is not an integer from 0 to 255 with -2 before the FFI call", () => {
    // No webview behind it (new Webview(handle) would call webview_set_size
    // on the handle): the channels are refused before the handle is read.
    const webview = Object.create(Webview.prototype) as Webview;
    const bad = [-1, 256, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 4294967296];
    for (const value of bad) {
      for (const channel of [0, 1, 2, 3]) {
        const rgba = [0, 0, 0, 255];
        rgba[channel] = value;
        expect(
          thrown(() =>
            webview.setBackgroundColor(rgba[0]!, rgba[1]!, rgba[2]!, rgba[3]!),
          ),
        ).toEqual({ fn: "webview_set_background_color", code: -2 });
      }
    }
  });

  test("an empty chunk against a destroyed handle is refused with -3, like any chunk", () => {
    for (const chunk of [new Uint8Array(0), new ArrayBuffer(0), "", "x"]) {
      expect(
        thrown(() => writeWebviewResponseChunk(stale, 1n, chunk)),
      ).toEqual({ fn: "webview_write_response_chunk", code: -3 });
    }
  });
});

// Runs a fixture in a child process with a timeout (a hang fails the test
// rather than the run) and returns its `RESULT <json>` line, parsed.
function runFixture(name: string, args: string[] = [], timeout = 60_000) {
  const fixture = new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  // Its own WebView2 user data folder: the default one (%APPDATA%\bun.exe)
  // is shared with every other Bun process that opens a webview, and
  // WebView2 refuses a second environment on a folder in use.
  const userData = mkdtempSync(join(tmpdir(), "sweetview-webview-bun-"));
  let proc;
  try {
    proc = Bun.spawnSync([process.execPath, fixture, ...args], {
      timeout,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: userData },
    });
  } finally {
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // WebView2's child processes can hold files for a moment.
    }
  }
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "));
  if (!line) {
    throw new Error(
      `fixture ${name} ${args.join(" ")} gave no result (exit ${proc.exitCode}, signal ${proc.signalCode})\n${stdout}\n${stderr}`,
    );
  }
  return { r: JSON.parse(line.slice("RESULT ".length)), exitCode: proc.exitCode };
}

describe.if(process.platform === "win32" || process.platform === "darwin")(
  "live webview",
  () => {
    test("dynamic HTML, POST echo, binary image, cross-origin iframe, static assets", () => {
      const { r, exitCode } = runFixture("live-request-handler.ts");
      // run() returned, the webview was destroyed with a request still open, and the process exited cleanly.
      expect(exitCode).toBe(0);
      console.log(JSON.stringify(r, null, 2));
      const p = r.page;
      const origin = r.assetOrigin;
      const frames = r.framesOrigin;

      expect(p.error).toBeUndefined();
      expect(r.externalDrop).toBe("ok");
      // webview_set_file_drop_handler registers and clears without error.
      expect(r.fileDropSetClear).toBe("ok");
      // A file drop handler that clears itself from inside its own call
      // (called through its native pointer, as the library calls it): the
      // callback it runs in waits until the call returns, then closes on the
      // next handler change.
      expect(r.reentrantDrop).toEqual({
        calls: 1,
        paths: ["/reentrant"],
        pendingInsideCall: 1,
        pendingAfterReturn: 1,
        pendingAfterNextSet: 0,
      });

      // Dynamic HTML from the handler at the main origin.
      expect(p.parentOrigin).toBe(origin);
      // Static assets still answer first, from webview_set_asset.
      expect(p.staticScript).toBe("static-ok");
      expect(p.staticFetch).toBe("asset-text");
      const paths = r.requests.map(
        (q: { url: string }) => new URL(q.url).pathname,
      );
      expect(paths).not.toContain("/static.js");
      expect(paths).not.toContain("/asset.txt");

      // POST with a body and a custom header, answered asynchronously.
      expect(p.echoStatus).toBe(201);
      expect(p.echoContentType).toBe("application/json");
      expect(p.echo.method).toBe("POST");
      expect(p.echo.query).toBe("?x=1");
      expect(p.echo.header).toBe('hello "world"');
      expect(JSON.parse(p.echo.body)).toEqual({ ping: "pong", n: 42 });
      // Repeated headers survive.
      expect(p.echoMulti).toBe("a, b");
      // Bad header JSON is refused with WEBVIEW_ERROR_INVALID_ARGUMENT (-2)
      // before anything is queued, and the request stays open for the real
      // answer: trailing text after a literal ({"X-Example":trueish}), an
      // escaped NUL, a name that is not a token, a lone surrogate, a raw tab
      // inside a string, CR LF in a value.
      expect(p.rawRejections).toBe("-2,-2,-2,-2,-2,-2");
      // The same through completeWebviewRequest, which throws WebviewError.
      expect(p.wrapperRejections).toBe("-2,-2,-2,-2");
      // Nothing was injected.
      expect(p.echoInjected).toBeNull();
      expect(p.echoEvil).toBeNull();

      // A service worker's own fetch reaches the handler, not the network.
      // Windows only: WebKit allows service workers only on http: and https:
      // origins, and macOS serves the page from the webview: scheme.
      if (process.platform === "win32") {
        expect(p.sw).toEqual({ status: 200, text: "sw-ok" });
        expect(paths).toContain("/sw.js");
        expect(paths).toContain("/from-sw");
      } else {
        expect(p.sw).toBeUndefined();
      }

      // Binary image completed from a worker thread.
      expect(p.imgEvent).toBe("load");
      expect(p.img).toEqual({ w: 1, h: 1 });

      // Cross-origin iframe from the frames origin: the browser isolates it.
      expect(p.frameOrigin).toBe(frames);
      expect(p.frameEventOrigin).toBe(frames);
      expect(p.frameOrigin).not.toBe(p.parentOrigin);
      expect(p.frameHref).toBe(`${frames}/sandbox.html`);
      expect(String(p.frameDocumentAccess)).toStartWith("blocked:");

      // Seen from inside the iframe: no bridge and no bound functions...
      const f = p.frameProbe;
      expect(f.error).toBeUndefined();
      expect(f.hasBridge).toBe(false);
      // ...no access to the parent document...
      expect(f.parentDocBlocked).toBe("SecurityError");
      // ...no CORS read of the main origin...
      expect(f.crossOriginFetchBlocked).toBe("blocked");
      // ...raw RPC posts to the native channels never run a host binding...
      expect(Array.isArray(f.rawPostAttempted)).toBe(true);
      expect(r.iframeEscaped).toBe(false);
      // ...and its own origin's subresources still load.
      expect(f.subresourceStatus).toBe(200);
      expect(f.subresourceLoaded).toEqual({ frameData: "frame-ok" });
      expect(r.requests.map((q: { url: string }) => q.url)).toContain(
        `${frames}/frame-data.json`,
      );

      // Unknown paths reach the handler, which answers 404.
      expect(p.missingStatus).toBe(404);
      expect(paths).toContain("/nothing-here");

      if (process.platform === "win32") {
        // Server-Sent Events streamed from a worker, no socket: all three
        // arrive in order, as separate events (event 2 was written in two
        // halves, 100 ms apart), over one connection, with no reconnect.
        const sse = p.sse;
        expect(sse.timeout).toBeUndefined();
        expect(sse.events.map((e: { n: number }) => e.n)).toEqual([1, 2, 3]);
        expect(sse.events.map((e: { id: string }) => e.id)).toEqual([
          "1",
          "2",
          "3",
        ]);
        expect(paths.filter((q: string) => q === "/sse")).toHaveLength(1);
        const last = sse.events[2].data;
        // WebView2 hands the page an intercepted response only once its body
        // has ended (WebView2Feedback #3519; the ICoreWebView2WebResource-
        // Response docs require all content by the time the deferral
        // completes), so every event arrives together, after the last write.
        // If a future WebView2 Runtime delivers partial bodies, the page acks
        // event 1 before event 2 is written and these flip: update the docs
        // of webview_begin_response then.
        expect(last.ack1BeforeEvent2).toBe(false);
        expect(last.ack2BeforeEvent3).toBe(false);
        expect(sse.events[0].receivedAt).toBeGreaterThanOrEqual(last.writtenAt);
        // Bad header JSON, a bad status and a NULL chunk with a length are
        // refused (-2) before anything is sent; a second begin for the same
        // request is WEBVIEW_ERROR_DUPLICATE (1).
        expect(last.badBegin).toBe(-2);
        expect(last.badStatus).toBe(-2);
        expect(last.badChunk).toBe(-2);
        expect(last.duplicateBegin).toBe(1);

        // OS file drops: the drop script ran enabled, took a drop carrying
        // files from the page, and let go of drops once the handler was
        // cleared. A File made in script has no path, so the handler never
        // ran.
        expect(p.fileDrop).toEqual({
          enabledFlag: true,
          prevented: true,
          clearedFlag: false,
          preventedAfterClear: false,
        });
        expect(r.fileDropCalls).toEqual([]);
      }

      // A request still open when the webview is destroyed is released
      // unanswered (Windows: the deferral is released without Complete();
      // macOS: the task is released and WebKit stops it), and run() returns.
      expect(r.neverOpened).toBe(true);
      expect(paths).toContain("/never");

      // After webview_destroy, completing against the stale handle is
      // refused with WEBVIEW_ERROR_INVALID_STATE (-3) instead of crashing,
      // from the main thread and from a worker, wrapper and raw call alike.
      expect(r.afterDestroyMain).toBe(-3);
      expect(r.afterDestroyWorker).toEqual({ wrapper: -3, raw: -3 });
      // Webview.completeRequest after destroy() throws -3 too.
      expect(r.afterDestroyMethod).toBe(-3);
      // An empty chunk after destroy is refused with -3, not skipped.
      expect(r.emptyChunkAfterDestroy).toBe(-3);
    }, 90_000);
  },
);

// Replacing, clearing and destroying from inside the handlers' own calls.
// Each scenario runs in its own process with a timeout, so a teardown that
// hangs (webview_destroy run inside WebView2's WebResourceRequested) fails
// here.
describe.if(process.platform === "win32" || process.platform === "darwin")(
  "live webview: changes from inside a handler's own call",
  () => {
    // What a destroyed webview answers: WEBVIEW_ERROR_INVALID_STATE (-3).
    const destroyedCodes = {
      completeRequest: -3,
      setRequestHandler: -3,
      setFileDropHandler: -3,
    };

    test("the request handler replaces itself, then the replacement clears itself", () => {
      const { r, exitCode } = runFixture("live-callback-teardown.ts", [
        "request-replace-clear",
      ]);
      expect(exitCode).toBe(0);
      expect(r.page).toEqual([
        { path: "/a", status: 200, body: "from-A" },
        { path: "/b", status: 200, body: "from-B" },
        // No handler: the library answers 404.
        { path: "/c", status: 404, body: expect.any(String) },
      ]);
      // /a went to A, /b to its replacement B, /c to neither.
      expect(r.calls).toContain("A/a");
      expect(r.calls).toContain("B/b");
      expect(r.calls).not.toContain("A/b");
      expect(r.calls.filter((c: string) => c.endsWith("/c"))).toEqual([]);
      // Each released callback waited for its own call to return...
      expect(r.pendingAfterReplaceInsideCall).toBe(1);
      expect(r.pendingAfterClearInsideCall).toBe(1);
      // ...and every one was closed by the end.
      expect(r.pendingAtEnd).toBe(0);
    }, 90_000);

    test("the request handler destroys the webview from inside WebResourceRequested without hanging", () => {
      const { r, exitCode } = runFixture("live-callback-teardown.ts", [
        "request-destroy",
      ]);
      expect(exitCode).toBe(0);
      expect(r.destroyedInsideCall).toBe(true);
      // Destroyed at once, inside the call: every checked API throws -3.
      expect(r.insideCall).toEqual(destroyedCodes);
      // run() returned and the deferred teardown ran.
      expect(r.runReturned).toBe(true);
      expect(r.afterRun).toEqual(destroyedCodes);
      // Nothing reached the handler once it had destroyed the webview, and
      // the page never got to finish.
      expect(r.callsAfterDestroy).toBe(0);
      expect(r.pageFinished).toBeUndefined();
      expect(r.pendingAtEnd).toBe(0);
    }, 90_000);

    test("the file drop handler replaces itself, clears itself, and destroys the webview from inside its call", () => {
      const { r, exitCode } = runFixture("live-callback-teardown.ts", [
        "drop-replace-clear-destroy",
      ]);
      expect(exitCode).toBe(0);
      expect(r.firstCalled).toBe(true);
      expect(r.secondCalled).toBe(true);
      expect(r.thirdCalled).toBe(true);
      expect(r.fourthCalled).toBe(true);
      // A ran once and handed over to B, which ran once and cleared itself;
      // C destroyed the webview and was not called again.
      expect(r.drops).toEqual(["A:/one", "B:/two", "C:/three"]);
      expect(r.ptrAfterClear).toBe(true);
      expect(r.pendingAfterReplaceInsideCall).toBe(1);
      expect(r.pendingAfterClearInsideCall).toBe(1);
      expect(r.insideCall).toEqual(destroyedCodes);
      expect(r.runReturned).toBe(true);
      expect(r.afterRun).toEqual(destroyedCodes);
      expect(r.pendingAtEnd).toBe(0);
    }, 90_000);
  },
);

describe("binding error serialization", () => {
  test("an Error becomes its message, undefined becomes empty, the rest JSON or String()", () => {
    expect(serializeBindingError(new Error("boom"))).toBe('"boom"');
    expect(serializeBindingError(new TypeError("typed"))).toBe('"typed"');
    expect(serializeBindingError(undefined)).toBe("");
    expect(serializeBindingError("plain")).toBe('"plain"');
    expect(serializeBindingError({ reason: "x" })).toBe('{"reason":"x"}');
    expect(serializeBindingError(null)).toBe("null");
    // JSON.stringify throws on a BigInt and on a cycle, and drops a symbol.
    expect(serializeBindingError(10n)).toBe('"10"');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(serializeBindingError(cycle)).toBe('"[object Object]"');
    expect(serializeBindingError(Symbol("s"))).toBe('"Symbol(s)"');
  });
});

describe.if(process.platform === "win32" || process.platform === "darwin")(
  "live webview: bindings",
  () => {
    test("bind: a thrown Error rejects with its message, undefined resolves, a duplicate bindRaw is refused with 1 and the original stays", () => {
      const { r, exitCode } = runFixture("live-bind.ts", ["results-and-errors"]);
      expect(exitCode).toBe(0);
      expect(r.page).toEqual({
        boom: { type: "string", value: "boom" },
        throwsObject: { reason: "plain" },
        nothing: "undefined",
        original: "original",
      });
      expect(r.duplicate).toBe(1);
      expect(r.duplicateCalled).toBe(false);
      expect(r.unbindUnknown).toBe(2);
      expect(r.runReturned).toBe(true);
      // Destroyed webviews leave `instances`.
      expect(r.instancesAfterRun).toBe(0);
    }, 90_000);

    test("destroy() of a webview that never ran does not end the next webview's run()", () => {
      const { r, exitCode } = runFixture("live-bind.ts", [
        "destroy-unrun-then-run",
      ]);
      expect(exitCode).toBe(0);
      expect(r.instancesAfterFirst).toBe(0);
      expect(r.secondPageRan).toBe(true);
      expect(r.runReturned).toBe(true);
      expect(r.instancesAfterRun).toBe(0);
    }, 90_000);
  },
);

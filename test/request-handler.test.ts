// The request handler, the frames origin and external drop, against the
// shipped library in build/. The live part opens a real webview (WebView2 on
// Windows) in a child process; nothing listens on a socket.
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPath } from "../src/ffi";

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
});

describe.if(process.platform === "win32" || process.platform === "darwin")(
  "live webview",
  () => {
    test("dynamic HTML, POST echo, binary image, cross-origin iframe, static assets", () => {
      const fixture = new URL(
        "./fixtures/live-request-handler.ts",
        import.meta.url,
      ).pathname.replace(/^\/([A-Za-z]:)/, "$1");
      // Its own WebView2 user data folder: the default one (%APPDATA%\bun.exe)
      // is shared with every other Bun process that opens a webview, and
      // WebView2 refuses a second environment on a folder in use.
      const userData = mkdtempSync(join(tmpdir(), "sweetview-webview-bun-"));
      let proc;
      try {
        proc = Bun.spawnSync([process.execPath, fixture], {
          timeout: 60_000,
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
          `fixture gave no result (exit ${proc.exitCode}, signal ${proc.signalCode})\n${stdout}\n${stderr}`,
        );
      }
      const r = JSON.parse(line.slice("RESULT ".length));
      // run() returned, the webview was destroyed with a request still open, and the process exited cleanly.
      expect(proc.exitCode).toBe(0);
      console.log(JSON.stringify(r, null, 2));
      const p = r.page;
      const origin = r.assetOrigin;
      const frames = r.framesOrigin;

      expect(p.error).toBeUndefined();
      expect(r.externalDrop).toBe("ok");

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

      // A request still open when the webview is destroyed is answered and released.
      expect(r.neverOpened).toBe(true);
      expect(paths).toContain("/never");

      // After webview_destroy, completing against the stale handle is
      // refused with WEBVIEW_ERROR_INVALID_STATE (-3) instead of crashing,
      // from the main thread and from a worker, wrapper and raw call alike.
      expect(r.afterDestroyMain).toBe(-3);
      expect(r.afterDestroyWorker).toEqual({ wrapper: -3, raw: -3 });
      // Webview.completeRequest after destroy() throws -3 too.
      expect(r.afterDestroyMethod).toBe(-3);
    }, 90_000);
  },
);

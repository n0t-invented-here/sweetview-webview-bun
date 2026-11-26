// Answers requests from a thread other than the one running the webview: the
// pattern for async work while Webview.run() blocks its thread, and proof
// that webview_complete_request is safe to call from any thread, including
// after the webview is destroyed.
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import { encodeCString, libraryPath } from "../../src/ffi";
import {
  completeWebviewRequest,
  WebviewError,
  type WebviewRequest,
} from "../../src/index";

declare var self: Worker;

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

// The raw C function, to hand it header JSON that JSON.stringify never makes.
const raw = dlopen(libraryPath, {
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
});

// Header JSON the library must refuse with WEBVIEW_ERROR_INVALID_ARGUMENT (-2)
// before anything is queued, leaving the request open.
const BAD_HEADERS_JSON = [
  '{"X-Example":trueish}', // trailing text after a literal
  '{"X-Example":"a\\u0000b"}', // escaped NUL
  '{"Bad Name":"a"}', // not an RFC 9110 token
  '{"X-A":"\\ud83d"}', // lone surrogate
  '{"X-A":"a\tb"}', // raw control character in a string
  JSON.stringify({ "X-Evil": "ok\r\nX-Injected: yes" }), // CR LF in a value
];

function errorCode(fn: () => void): number | string {
  try {
    fn();
    return 0;
  } catch (e) {
    return e instanceof WebviewError ? e.code : String(e);
  }
}

self.onmessage = async (e: MessageEvent) => {
  const data = e.data as {
    handle: number;
    request?: WebviewRequest;
    afterDestroy?: { id: string };
  };
  const handle = data.handle as unknown as Pointer;

  if (data.afterDestroy) {
    // The webview is gone: both the wrapper and the raw call must refuse
    // with WEBVIEW_ERROR_INVALID_STATE (-3), not crash.
    const id = BigInt(data.afterDestroy.id);
    postMessage({
      afterDestroy: {
        wrapper: errorCode(() =>
          completeWebviewRequest(handle, id, { status: 200, body: "late" }),
        ),
        raw: raw.symbols.webview_complete_request(
          handle,
          id,
          200,
          encodeCString('{"X-A":"1"}'),
          null,
          0n,
        ),
      },
    });
    return;
  }

  const request = data.request!;
  const url = new URL(request.url);
  // Real async work on this thread's event loop.
  await Bun.sleep(5);
  if (url.pathname === "/dynamic.png") {
    completeWebviewRequest(handle, request.id, {
      headers: { "Content-Type": "image/png" },
      body: PNG,
    });
    return;
  }
  if (url.pathname === "/api/echo") {
    // Every bad header set is refused, and the request stays open for the
    // real answer below.
    const rawRejections = BAD_HEADERS_JSON.map((json) =>
      raw.symbols.webview_complete_request(
        handle,
        request.id,
        200,
        encodeCString(json),
        null,
        0n,
      ),
    );
    const badHeaders: Record<string, string>[] = [
      { "Bad Name": "x" },
      { "X-Evil": "ok\r\nX-Injected: yes" },
      { "X-Nul": "a\0b" },
      { "": "empty name" },
    ];
    const wrapperRejections = badHeaders.map((headers) =>
      errorCode(() =>
        completeWebviewRequest(handle, request.id, { status: 200, headers }),
      ),
    );
    const header =
      request.headers.find(
        ([n]) => n.toLowerCase() === "x-sweetview-test",
      )?.[1] ?? null;
    completeWebviewRequest(handle, request.id, {
      status: 201,
      headers: [
        ["Content-Type", "application/json"],
        ["X-Multi", "a"],
        ["X-Multi", "b"],
        ["X-Raw-Rejections", rawRejections.join(",")],
        ["X-Wrapper-Rejections", wrapperRejections.join(",")],
      ],
      body: JSON.stringify({
        method: request.method,
        query: url.search,
        header,
        body: request.body ? new TextDecoder().decode(request.body) : null,
      }),
    });
    return;
  }
  completeWebviewRequest(handle, request.id, { status: 404 });
};

postMessage("ready");

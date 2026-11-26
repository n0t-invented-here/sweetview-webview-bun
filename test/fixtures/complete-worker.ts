// Answers requests from a thread other than the one running the webview: the
// pattern for async work while Webview.run() blocks its thread, and proof
// that webview_complete_request is safe to call from any thread.
import { completeWebviewRequest, type WebviewRequest } from "../../src/index";

declare var self: Worker;

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

self.onmessage = async (e: MessageEvent) => {
  const { handle, request } = e.data as {
    handle: number;
    request: WebviewRequest;
  };
  const url = new URL(request.url);
  // Real async work on this thread's event loop.
  await Bun.sleep(5);
  if (url.pathname === "/dynamic.png") {
    completeWebviewRequest(handle as any, request.id, {
      headers: { "Content-Type": "image/png" },
      body: PNG,
    });
    return;
  }
  if (url.pathname === "/api/echo") {
    const header =
      request.headers.find(
        ([n]) => n.toLowerCase() === "x-sweetview-test",
      )?.[1] ?? null;
    completeWebviewRequest(handle as any, request.id, {
      status: 201,
      headers: [
        ["Content-Type", "application/json"],
        ["X-Multi", "a"],
        ["X-Multi", "b"],
        ["X-Evil", "ok\r\nX-Injected: yes"],
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
  completeWebviewRequest(handle as any, request.id, { status: 404 });
};

postMessage("ready");

# Requests and drops

Additions of the sweetview fork of the library (2.8.0), as methods on [`Webview`](webview.md):
answer the page's requests in code, give an `<iframe>` its own origin, and control drops from
outside the app. Nothing reaches the network and no socket is opened.

## `setRequestHandler(handler)`

```typescript
import { Webview } from "@n1h/sweetview-webview-bun";

const webview = new Webview();
webview.setAsset("index.html", "text/html; charset=utf-8", html);
webview.setRequestHandler((req) => {
  const { pathname } = new URL(req.url);
  if (pathname === "/api/time") {
    return {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ now: Date.now() }),
    };
  }
  return { status: 404 };
});
webview.navigate(`${webview.assetOrigin}/index.html`);
webview.run();
```

What goes to the handler:

- Every request to `assetOrigin` that no `setAsset` asset matches. Assets still answer first.
- Every request to `framesOrigin`.

Without a handler both answer 404. `setRequestHandler(null)` removes it.

The handler gets a `WebviewRequest`:

| Field     | Meaning                                                                     |
| --------- | --------------------------------------------------------------------------- |
| `id`      | A `bigint`; pass it to `completeRequest` to answer later                    |
| `method`  | `GET`, `POST`, ...                                                          |
| `url`     | The full URL, query string included                                         |
| `headers` | `[name, value]` pairs in the order the browser sent them; a name may repeat |
| `body`    | A `Uint8Array` copy of the request body, or `null`                          |

It answers in one of two ways:

- Return a `WebviewResponse`: `{ status?, headers?, body? }`. `status` defaults to 200. `headers` is
  an object or `[name, value]` pairs (pairs let `Set-Cookie` repeat). `body` is a string (UTF-8),
  `Uint8Array` or `ArrayBuffer`.
- Return nothing and call `completeRequest(req.id, response)` later.

A handler that throws answers 500. The request stays open until it is answered, and the page waits
for it. When the webview is destroyed, requests still open are answered 503.

### Async work goes on a worker

The handler runs on the thread that called `run()`, and `run()` blocks that thread: Bun runs no
microtasks, timers or I/O there until `run()` returns. A handler can return a promise, but it settles
only after the window closes. For anything that awaits, post the request to a `Worker` and answer it
there with `completeWebviewRequest`, which is safe on any thread:

```typescript
// main thread
const worker = new Worker(new URL("./requests.ts", import.meta.url));
webview.setRequestHandler((req) => {
  worker.postMessage({ handle: webview.unsafeHandle, req });
});

// requests.ts
import { completeWebviewRequest } from "@n1h/sweetview-webview-bun";
self.onmessage = async ({ data: { handle, req } }) => {
  const file = Bun.file(`./public${new URL(req.url).pathname}`);
  completeWebviewRequest(handle, req.id, {
    status: (await file.exists()) ? 200 : 404,
    headers: { "Content-Type": file.type },
    body: (await file.exists()) ? await file.bytes() : null,
  });
};
```

## `completeRequest(id, response)` and `completeWebviewRequest(handle, id, response)`

Answer a request handed to the handler. The headers and body are copied before the call returns.
Answering a request twice, or one the browser cancelled, does nothing. `completeWebviewRequest` is
the same thing as a free function that takes the webview's `unsafeHandle`, for workers.

## `framesOrigin`

A second origin, cross-origin from `assetOrigin`, for content the page must not reach into, such as
a sandboxed `<iframe>`. Every request to it goes to the handler. The browser enforces the boundary:
the page cannot read the frame's document, and the two talk through `postMessage`.

| Platform | `assetOrigin`              | `framesOrigin`                    | How                                                    |
| -------- | -------------------------- | --------------------------------- | ------------------------------------------------------ |
| Windows  | `http://webview.localhost` | `http://frames.webview.localhost` | WebView2's `WebResourceRequested`, deferred            |
| macOS    | `webview://localhost`      | `webview-frames://localhost`      | A `WKURLSchemeHandler` for `webview`, `webview-frames` |
| Linux    |                            |                                   | Accepted; not served                                   |

## `setAllowExternalDrop(allow)`

Whether files and other content dragged from outside the app can be dropped on the page. Allowed by
default. Windows: `ICoreWebView2Controller4::AllowExternalDrop`. macOS, Linux: accepted; does
nothing.

## Errors

The methods throw a `WebviewError` (with the C function's name and its `webview_error_t` code) when
the library refuses a call.

## Tests

`bun test` opens a real webview and checks all of the above end to end: dynamic HTML, a `POST` with
a body and a custom header answered from a worker, a binary image, a cross-origin `<iframe>` from
`framesOrigin`, and that `setAsset` assets still answer first.

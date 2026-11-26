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
  an object or `[name, value]` pairs (pairs let a name repeat). `body` is a string (UTF-8),
  `Uint8Array` or `ArrayBuffer`.
- Return nothing and call `completeRequest(req.id, response)` later.

A handler that throws answers 500, and so does a response returned from the handler that is refused
(bad headers, a status outside 100-599, a body over 4 GiB - 1): a returned response never strands
the request. A request the handler leaves to `completeRequest` stays open until it is answered, and
the page waits for it. Destroying the webview closes and releases every request still open, unanswered,
on both platforms; none of them is passed on to the network:

| Platform | Open requests at destroy                                                                     |
| -------- | -------------------------------------------------------------------------------------------- |
| Windows  | The WebView2 controller is closed, then each deferral is released without being completed |
| macOS    | The `WKURLSchemeTask`s are released unanswered; WebKit stops them as it closes              |

A request whose body cannot be read in full never reaches the handler: Windows answers it 500, macOS
fails it with the stream's error.

### Response headers

Checked before the call returns; a bad set throws a `WebviewError` with code -2
(`WEBVIEW_ERROR_INVALID_ARGUMENT`) and answers nothing, so the request stays open for a good answer.

- Each name must be an RFC 9110 token: not empty, no spaces, `:`, `(`, `"` or non-ASCII.
- Each value must be free of CR, LF, NUL and other control characters but tab. Nothing is stripped
  or rewritten, so nothing can be injected.

Repeated names go out differently per platform:

| Platform | Repeated names                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | Each pair is its own header line; several `Set-Cookie` headers work                                                                                                     |
| macOS    | `NSHTTPURLResponse` holds one value per name: names match regardless of case, repeats are joined with `", "`, and only the first `Set-Cookie` is kept (it cannot be joined) |

So on macOS a response carries **at most one `Set-Cookie`**. Use a combinable header (`X-Multi: a`
and `X-Multi: b` arrive as `a, b`) when a value must repeat on both platforms.

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

### Shutting the worker down

`run()` destroys the webview when it returns. A worker may still be answering then:

- `completeWebviewRequest` against a destroyed webview throws a `WebviewError` with code -3
  (`WEBVIEW_ERROR_INVALID_STATE`). The library keeps a registry of live webviews and checks the
  handle against it under a lock, so a late call is refused rather than touching freed memory, from
  any thread.
- An answer queued just before the destroy does nothing when it runs.
- Still stop the worker after `run()` returns, and catch the error in the worker if it may answer
  late:

```typescript
webview.run(); // destroys the webview on return
worker.terminate();
```

## `completeRequest(id, response)` and `completeWebviewRequest(handle, id, response)`

Answer a request handed to the handler. The headers are checked (see
[Response headers](#response-headers)) and the headers and body copied before the call returns.
Answering a request twice, or one the browser cancelled, does nothing. `completeWebviewRequest` is
the same thing as a free function that takes the webview's `unsafeHandle`, for workers.

Both throw a `WebviewError`: -2 for bad headers, a status outside 100-599 or a body over 4 GiB - 1;
-3 once the webview is destroyed or being destroyed (`completeRequest` throws -3 after `destroy()`
too, the same as `completeWebviewRequest` on the stale handle).

A refused call answers nothing: the request stays open, and the caller still owes it an answer (a
good response, or `{ status: 500 }`). This differs from returning a response from the handler,
where a refused response is caught and answered 500 for you.

## `framesOrigin`

A second origin, cross-origin from `assetOrigin`, for content the page must not reach into, such as
a sandboxed `<iframe>`. Every request to it goes to the handler. The browser enforces the boundary:
the page cannot read the frame's document, and the two talk through `postMessage`.

| Platform | `assetOrigin`              | `framesOrigin`                    | How                                                    |
| -------- | -------------------------- | --------------------------------- | ------------------------------------------------------ |
| Windows  | `http://webview.localhost` | `http://frames.webview.localhost` | WebView2's `WebResourceRequested`, deferred (\*)       |
| macOS    | `webview://localhost`      | `webview-frames://localhost`      | A `WKURLSchemeHandler` for `webview`, `webview-frames` |
| Linux    |                            |                                   | Accepted; not served                                   |

(\*) Requests from service workers and shared workers are caught too, with
`AddWebResourceRequestedFilterWithRequestSourceKinds`, on WebView2 Runtime 125 or later; an older
Runtime reports only document requests. A response WebView2 refuses to build goes out as a bare 500,
never on to the network.

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
`framesOrigin`, that `setAsset` assets still answer first, a service worker's own `fetch` reaching
the handler, bad response headers (`{"X-Example":trueish}`, an escaped NUL, a name with a space, a
lone surrogate, CR LF) refused with -2, and `completeWebviewRequest` after the webview is destroyed
refused with -3 from the main thread and from a worker, as is `completeRequest` after `destroy()`.
The service worker check runs on Windows only: WebKit allows service workers only on `http:` and
`https:` origins, not on the `webview:` scheme macOS serves from.

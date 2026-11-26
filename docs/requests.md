# Requests and drops

Additions of the sweetview fork of the library (2.8.0), as methods on [`Webview`](webview.md):
answer the page's requests in code (whole, or streamed in chunks), give an `<iframe>` its own
origin, control drops from outside the app, and receive the paths of files dropped from the OS.
Nothing reaches the network and no socket is opened.

Implemented on Windows (WebView2) and macOS (WKWebView). On Linux the calls exist, for the C ABI the
library shares with upstream webview/webview, and are accepted without effect. The checked-in Linux
binary predates these additions; see [Shipped binaries](#shipped-binaries).

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

macOS: WebKit hands the request handler only the parts of a body the page holds in memory. A body
that is a `Blob`, or a `FormData` containing a `File` or `Blob`, arrives as `null`, from `fetch` and
`XMLHttpRequest` alike. Strings, `ArrayBuffer` and typed arrays, `URLSearchParams`, and a `FormData`
of text fields arrive whole. A page that uploads files reads them first, which works on both
platforms:

```js
await fetch("/upload", { method: "POST", body: await blob.arrayBuffer() });

const encoded = new Response(formData); // multipart/form-data, files included
await fetch("/upload", {
  method: "POST",
  headers: { "Content-Type": encoded.headers.get("Content-Type") },
  body: await encoded.arrayBuffer(),
});
```

It answers in one of three ways:

- Return a `WebviewResponse`: `{ status?, headers?, body? }`. `status` defaults to 200. `headers` is
  an object or `[name, value]` pairs (pairs let a name repeat). `body` is a string (UTF-8),
  `Uint8Array` or `ArrayBuffer`.
- Return nothing and call `completeRequest(req.id, response)` later.
- Return nothing and stream the answer: `beginResponse`, `writeResponseChunk`, `endResponse` (see
  [Streaming](#streaming)).

The handler may replace or clear itself (`setRequestHandler(...)`, `setRequestHandler(null)`) or
`destroy()` the webview from inside its own call; the native callback it runs in is closed only
after that call has returned. A `destroy()` there takes effect at once (no handler runs again, and
`completeRequest`, `setRequestHandler` and `setFileDropHandler` throw `WebviewError` code -3), and
the native teardown runs once the call has returned, when `run()` returns or on the next turn of
the event loop, never inside WebView2's `WebResourceRequested`.

A handler that throws answers 500, and so does a response returned from the handler that is refused
(bad headers, a status outside 100-599, a body over 4 GiB - 1): a returned response never strands
the request. A request the handler leaves to `completeRequest` stays open until it is answered, and
the page waits for it. Destroying the webview closes and releases every request still open, unanswered,
on both platforms; none of them is passed on to the network:

| Platform | Open requests at destroy                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows  | Every open stream is aborted, the WebView2 controller is closed, then each pending deferral and its event args are released without being completed |
| macOS    | The retained `WKURLSchemeTask`s, streamed or not, are released unanswered; WebKit stops them as it closes                                  |

On both, answers and stream steps still queued for the UI thread do nothing when they run.

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

Both throw a `WebviewError`: -2 for bad headers, a status that is not an integer from 100 to 599
(checked before the call, so `4294967496` or `200.5` is refused rather than wrapped or truncated
to 200), or a body over 4 GiB - 1;
-3 once the webview is destroyed or being destroyed (`completeRequest` throws -3 after `destroy()`
too, the same as `completeWebviewRequest` on the stale handle).

A refused call answers nothing: the request stays open, and the caller still owes it an answer (a
good response, or `{ status: 500 }`). This differs from returning a response from the handler,
where a refused response is caught and answered 500 for you.

## Streaming

```typescript
webview.setRequestHandler((req) => {
  if (new URL(req.url).pathname !== "/events") return { status: 404 };
  worker.postMessage({ handle: webview.unsafeHandle, id: req.id });
});

// worker.ts
import {
  beginWebviewResponse,
  endWebviewResponse,
  writeWebviewResponseChunk,
} from "@n1h/sweetview-webview-bun";
self.onmessage = async ({ data: { handle, id } }) => {
  beginWebviewResponse(handle, id, {
    headers: { "Content-Type": "text/event-stream" },
  });
  for (let i = 1; i <= 3; i++) {
    writeWebviewResponseChunk(handle, id, `data: event ${i}\n\n`);
    await Bun.sleep(100);
  }
  endWebviewResponse(handle, id);
};
```

| Method on `Webview`             | Free function for workers                         | Does                                                       |
| ------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `beginResponse(id, head?)`      | `beginWebviewResponse(handle, id, head?)`         | Sends the status (default 200) and headers                 |
| `writeResponseChunk(id, chunk)` | `writeWebviewResponseChunk(handle, id, chunk)`    | Appends body bytes; a string is UTF-8; the bytes are copied |
| `endResponse(id)`               | `endWebviewResponse(handle, id)`                  | Ends the body                                              |

Use streaming instead of `completeRequest`, never both for one request. All six are safe on any
thread, like `completeWebviewRequest`.

- `head` takes `status` and `headers`, checked exactly as for `completeRequest` (see
  [Response headers](#response-headers)): a bad one throws -2 before anything is sent.
- A chunk over 4 GiB - 1 throws -2. An empty chunk writes nothing but is still checked, so after the
  webview is destroyed it throws -3 like any other.
- Beginning a request already answered or cancelled does nothing, and its chunks are dropped.
  Beginning one whose stream is already open throws `WEBVIEW_ERROR_DUPLICATE` (code 1) on Windows;
  macOS ignores the second begin.
- Ending twice, or a response never begun, does nothing; a request never begun can still be
  answered with `completeRequest`.
- Once the webview is destroyed, all of them throw -3 (`WEBVIEW_ERROR_INVALID_STATE`). The methods
  on `Webview` throw -3 after `destroy()` too.

| Platform | How the page receives it                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | The body is an `IStream` WebView2 reads on its own thread, so the UI thread never waits. WebView2 hands the response to the page only once the whole body is read (WebView2Feedback #3519), so an `EventSource` gets every event at `endResponse`, not one by one |
| macOS    | `didReceiveResponse:`, `didReceiveData:` per chunk and `didFinish` on the `WKURLSchemeTask`, in order on the main queue: Server-Sent Events and large media reach the page as they are written                                                                   |
| Linux    | Accepted; does nothing                                                                                                                                                                                                                                       |

## `framesOrigin`

A second origin, cross-origin from `assetOrigin`, for content the page must not reach into, such as
a sandboxed `<iframe>`. Every request to it goes to the handler. The browser enforces the boundary:
the page cannot read the frame's document, and the two talk through `postMessage`.

| Platform | `assetOrigin`              | `framesOrigin`                    | How                                                    |
| -------- | -------------------------- | --------------------------------- | ------------------------------------------------------ |
| Windows  | `http://webview.localhost` | `http://frames.webview.localhost` | WebView2's `WebResourceRequested`, deferred (\*)       |
| macOS    | `webview://localhost`      | `webview-frames://localhost`      | A `WKURLSchemeHandler` for `webview`, `webview-frames` |
| Linux    |                            |                                   | Accepted; not served                                   |

Only those exact origins reach the handler. On macOS a request to the `webview` or `webview-frames`
scheme with any other authority (`webview://other-host/...`, a port, userinfo) is answered 404 before
the asset table or the handler sees it; on Windows WebView2 routes only the two origins here.

(\*) Where the WebView2 Runtime has `ICoreWebView2_22` (Runtime 122.0.2365.46 or later; the
interface shipped in SDK 1.0.2365.46, and the library is built with SDK 1.0.2478.35), the filters are
added with `AddWebResourceRequestedFilterWithRequestSourceKinds` and all source kinds, so requests
from service workers, shared workers and cross-origin iframes are caught too. An older Runtime falls
back to the legacy filter, which misses those. A response WebView2 refuses to build goes out as a
bare 500, never on to the network.

## `setAllowExternalDrop(allow)`

Whether files and other content dragged from outside the app can be dropped on the page. Allowed by
default. Drags that start inside the page keep working either way. The file drop handler below
receives drops only while external drops are allowed.

| Platform | How                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | `ICoreWebView2Controller4::AllowExternalDrop`, for the whole WebView2 control. A Runtime without it throws `WEBVIEW_ERROR_UNSPECIFIED` (-1)                                                                                           |
| macOS    | The library's `WKWebView` subclass refuses drags from other apps (`NSDraggingInfo.draggingSource` is nil, as for Finder) and still hands in-app drags to WebKit. Each drag is routed once when it enters; refusing mid-drag ends it |
| Linux    | Accepted; does nothing                                                                                                                                                                                                                |

## `setFileDropHandler(handler)`

Receives the real filesystem paths of files dropped on the webview from the operating system
(Explorer, Finder) as a `string[]`. When the platform captures a file drop while a handler is set
(see the table below for where and when it does), the drop is taken from the page and the browser
does not open the dropped file; `null` hands drops back to the page.

On Windows and macOS alike:

- External drops must be allowed (`setAllowExternalDrop`).
- The handler runs asynchronously on the webview's thread, inside `run()`, after the operating
  system's drop event has returned. So it may call `setFileDropHandler(null)` or set another handler,
  open a dialog, or `destroy()` the webview; the native callback it runs in is closed only after the
  call returns, and a `destroy()` finishes its native teardown then too.
- It never gets an empty list.
- A change the library refuses throws a `WebviewError` and leaves the previous handler in place.

| Platform | How                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | Drops are captured only on the top-level document, never inside an `<iframe>` (a cross-origin one from `framesOrigin` included). The top-level document's drop event hands the dropped `File` objects to the host with `chrome.webview.postMessageWithAdditionalObjects`, and WebView2's `ICoreWebView2File` gives each path. A drop on an iframe is left to that iframe. Needs WebView2 Runtime 113 or later: on an older Runtime, which lacks `postMessageWithAdditionalObjects`, the drop is neither accepted nor prevented, so it is left to the page instead of being swallowed, and the callback is not called |
| macOS    | The library's `WKWebView` subclass takes a drag whose pasteboard holds file URLs and whose source allows copying, wherever on the view it lands, and reads the paths when the drop is performed; any other drag goes to WebKit. Clearing the handler, or refusing external drops, mid-drag refuses the drop                                                       |
| Linux    | Accepted; does nothing                                                                                                                                                                                                                                                                                                                                                 |

## Errors

The methods throw a `WebviewError` (with the C function's name and its `webview_error_t` code) when
the library refuses a call.

## Tests

`bun test` opens a real webview in a child process and checks, end to end: dynamic HTML, a `POST`
with a body and a custom header answered from a worker, a binary image, a cross-origin `<iframe>`
from `framesOrigin`, that `setAsset` assets still answer first, a service worker's own `fetch`
reaching the handler, bad response headers (`{"X-Example":trueish}`, an escaped NUL, a name with a
space, a lone surrogate, CR LF) refused with -2, `completeWebviewRequest` after the webview is
destroyed refused with -3 from the main thread and from a worker (as is `completeRequest` after
`destroy()`), a Server-Sent Events stream written from a worker with its chunk timing (each event
reaches the page before the next is written on macOS; all together after the end on Windows),
refused stream arguments and a duplicate begin, and `setAllowExternalDrop` both ways.

What the file drop tests cover, and what they do not:

- Covered: registering, clearing and re-registering the handler; a handler that clears itself
  from inside its own call (its native callback called the way the library calls it); and, on
  Windows, a synthetic drop: the page dispatches a `drop` event carrying a `File` it built, and the
  test checks that the drop script took it while a handler was set and let it go once cleared. A
  scripted `File` has no filesystem path, so the handler itself is not called there.
- Not covered here: a real drag from Explorer or Finder. The macOS drag routing is covered by the
  library's own tests (`ctest` in the `webview/` submodule), which call the `WKWebView` subclass's
  drag methods with a stand-in for the drag: a file drop taken and delivered, refused external
  drags, and external drops or the handler switched off mid-drag.

Without a window, `bun test` also checks the exports and argument checks of every call, including
`setBackgroundColor` refusing channels that are not integers from 0 to 255. The service worker check
runs on Windows only: WebKit allows service workers only on `http:` and `https:` origins, not on the
`webview:` scheme macOS serves from.

## Shipped binaries

The library is built from the `webview/` submodule (sweetview-webview) and checked in under
`build/`. Not every checked-in binary is current with this package's source (2.8.0):

| File                        | Built from                                   | Has the 2.8.0 additions (request handler, streaming, external drop, file drops) |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| `build/libwebview.dll`      | Current source, on Windows                   | Yes                                                                             |
| `build/libwebview.dylib`    | Current source, on macOS (arm64 + x86_64)    | Yes                                                                             |
| `build/libwebview-x64.so`   | An older fork commit                         | No (and Linux implements none of them; see below)                               |

`just build` builds the dylib with Apple Clang and the SDK's libc++ (`/usr/bin/clang`, whatever
`clang` is first on `PATH`), universal, with a deployment target of macOS 11.0: both slices declare
11.0 as their minimum and import only C++ runtime symbols that system has. A newer LLVM's libc++
headers would make it import `std::__hash_memory`, which only the newest macOS provides.

Assets, background color, the input hooks and permissions are in all three. Each 2.8.0 feature is
bound lazily and on its own, so a binary without one still serves everything else; calling a missing
one throws from `dlopen` when it is first used.


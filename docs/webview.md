# The `Webview` class

One instance is one native window with a web view in it.

```typescript
import { Webview, SizeHint } from "@n1h/sweetview-webview-bun";

const webview = new Webview();
webview.title = "Hello";
webview.size = { width: 800, height: 600, hint: SizeHint.NONE };
webview.setHTML(`<h1>Hello from bun v${Bun.version}</h1>`);
webview.run(); // blocks until the window closes, then destroys the instance
```

Declared in [`src/webview.ts`](../src/webview.ts); every member has its documentation there too.

## Creating

```typescript
new Webview(debug?: boolean, size?: Size, window?: Pointer | null)
```

| Argument | Default                                             | Meaning                                                                                                                       |
| -------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `debug`  | `false`                                             | `true` enables the developer tools where the platform has them                                                                |
| `size`   | `{ width: 1024, height: 768, hint: SizeHint.NONE }` | The window size. Pass `undefined` to leave the window as the platform makes it (on macOS it can stay invisible until resized) |
| `window` | `null`                                              | Unsafe. A native window handle (`GtkWindow`, `NSWindow` or `HWND` pointer) to embed the web view in; `null` creates a window  |

`new Webview(handle)` with a `Pointer` wraps an existing native webview handle. Unsafe.

## Window

| Member                           | Meaning                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `title = string`                 | Sets the window title                                                                                                                 |
| `size = { width, height, hint }` | Sets the window size. `hint` is a `SizeHint`: `NONE` (a size), `MIN` (a minimum), `MAX` (a maximum), `FIXED` (the user cannot resize) |
| `setBackgroundColor(r, g, b, a)` | The color behind the page, or transparency; see [Assets and background](assets-and-background.md)                                     |
| `unsafeHandle`                   | Unsafe. The native webview handle                                                                                                     |
| `unsafeWindowHandle`             | Unsafe. The native window handle: `GtkWindow`, `NSWindow` or `HWND` by platform                                                       |

## Content

| Member                        | Meaning                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `navigate(url)`               | Loads a URL. A `data:` URI works; it is re-encoded if needed                                                                   |
| `setHTML(html)`               | Loads the string as the page. Windows caps it at 2 MB; for anything bigger, or a page with its own files, use `setAsset`       |
| `setAsset(path, mime, data)`  | Serves bytes at the webview's own origin, then `navigate` to them; see [Assets and background](assets-and-background.md)       |
| `assetOrigin`                 | The origin `setAsset` serves at on this platform                                                                               |
| `setRequestHandler(handler)`  | Answers requests no asset matches, and every request to `framesOrigin`, in code; see [Requests and drops](requests.md)         |
| `completeRequest(id, res)`    | Answers a request the handler left open; `completeWebviewRequest` does the same from a worker                                  |
| `beginResponse(id, head?)`    | Starts a streamed answer: status and headers now; `beginWebviewResponse` does the same from a worker. See [Streaming](requests.md#streaming) |
| `writeResponseChunk(id, chunk)` | Appends body bytes to a streamed answer; `writeWebviewResponseChunk` from a worker                                           |
| `endResponse(id)`             | Ends a streamed answer; `endWebviewResponse` from a worker                                                                     |
| `framesOrigin`                | A second origin, cross-origin from `assetOrigin`, for `<iframe>`s the page must not reach into                                 |
| `setAllowExternalDrop(allow)` | Whether content dragged from outside the app can be dropped on the page (Windows and macOS); in-page drags keep working       |
| `setFileDropHandler(handler)` | Receives the real paths of files dropped from the OS (Windows and macOS); see [Requests and drops](requests.md)                |
| `init(source)`                | JavaScript run at the start of every page the webview opens, before `window.onload`. macOS: the top-level document only. Windows: WebView2 runs it in every frame, `<iframe>`s included, so guard top-level-only code with `if (window === window.top)` |
| `eval(source)`                | Runs JavaScript in the current page. Asynchronous; the result is discarded. Run it after the page has loaded, or it is dropped |

## Calling bun from the page

```typescript
webview.bind("press", (label: string, n: number) => {
  console.log(label, n);
  return { ok: true }; // sent back to the page
});
webview.setHTML(
  `<button onclick="press('hi', 1).then(console.log)">Press</button>`,
);
```

| Member                          | Meaning                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bind(name, callback)`          | Makes `window[name]` in the page an async function that calls `callback` in bun. Arguments arrive as JSON-converted values; the return value resolves the page's promise as JSON, and `undefined` resolves it with `undefined`. A thrown value, or arguments that are not valid JSON, rejects it: an `Error` arrives as its `message` string, other values as their JSON (or their `String()` form when JSON cannot hold them). A returned promise settles the page's call the same way when it fulfills or rejects; a result JSON cannot hold (a cycle, a BigInt) rejects it. Throws `WebviewError` code 1 (`WEBVIEW_ERROR_DUPLICATE`) when the name is already bound, leaving that binding in place. Top-level document only: calls from `<iframe>`s are dropped |
| `unbind(name)`                  | Removes the binding and frees its callback. A call the page made just before is not delivered; its promise rejects. Throws `WebviewError` code 2 (`WEBVIEW_ERROR_NOT_FOUND`) for a name not bound |
| `bindRaw(name, callback, arg?)` | The low-level form: `callback(seq, req, arg)` gets the request id and the raw JSON array of arguments, and answers with `return`. Throws `WebviewError` code 1 when the name is already bound, leaving that binding in place |
| `return(seq, status, result)`   | Answers a `bindRaw` request: `status` 0 with a JSON `result` resolves the page's promise; any other status rejects it with `result` as the error. An empty `result` stands for `undefined` |

## Running and ending

| Member      | Meaning                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `run()`     | Runs the window's event loop on this thread until the window closes, then calls `destroy()`                 |
| `destroy()` | Closes the window, frees the instance and its bindings. After `run()` returns it has already happened. Called from inside a handler or binding, it takes effect at once and the native teardown runs once that call returns |
| `unload()`  | A function, not a method: destroys every `Webview` this process created and closes the core library handle. The lazily bound feature groups, hooks and permissions are not closed, and installed hooks are not removed. For after all windows are closed; call nothing in the package afterwards |

`run()` blocks the thread: Bun runs no microtasks, timers or I/O there until it returns, so a
promise returned from a binding or a request handler settles only after the window closes. A bun
server or other async work runs on a worker;
[`examples/webserver/`](../examples/webserver) shows that.

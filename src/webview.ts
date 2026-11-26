import {
  CString,
  dlopen,
  FFIType,
  JSCallback,
  toArrayBuffer,
  type Pointer,
} from "bun:ffi";
import { encodeCString, instances, lib, libraryPath } from "./ffi";

// The sweetview fork's additions, bound on first use so that a library without them (an older
// build) still loads for everything else.
let forkLib: ReturnType<typeof openForkLib> | undefined;
function openForkLib() {
  return dlopen(libraryPath, {
    webview_set_background_color: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    webview_set_asset: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
}

// The request handler additions (library 2.8.0), bound on first use like the others.
let requestLib: ReturnType<typeof openRequestLib> | undefined;
function openRequestLib() {
  return dlopen(libraryPath, {
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
  });
}

// Streamed responses and OS file drops, bound on first use like the others.
let streamLib: ReturnType<typeof openStreamLib> | undefined;
function openStreamLib() {
  return dlopen(libraryPath, {
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
}

/** A `webview_error_t` other than `WEBVIEW_ERROR_OK` from the library. */
export class WebviewError extends Error {
  constructor(
    readonly fn: string,
    readonly code: number,
  ) {
    super(`${fn} failed with webview_error_t ${code}`);
    this.name = "WebviewError";
  }
}

function check(fn: string, code: number) {
  if (code !== 0) throw new WebviewError(fn, code);
}

/** A request to one of the webview's origins that no asset answered (see {@link Webview.setRequestHandler}). */
export interface WebviewRequest {
  /** Pass to {@link Webview.completeRequest} when answering it yourself. */
  id: bigint;
  /** The HTTP method, for example `GET` or `POST`. */
  method: string;
  /** The full URL, for example `http://webview.localhost/api?x=1`. */
  url: string;
  /** The request headers in the order the browser sent them; a name may repeat. */
  headers: [name: string, value: string][];
  /** The request body (a copy), or null when there is none. */
  body: Uint8Array | null;
}

/** The answer to a {@link WebviewRequest}. */
export interface WebviewResponse {
  /** HTTP status code, 100 to 599. Defaults to 200. */
  status?: number;
  /**
   * Response headers: an object of name to value, or `[name, value]` pairs,
   * which allow a name to repeat. Each name must be an RFC 9110 token and each
   * value free of CR, LF, NUL and other control characters but tab; anything
   * else throws a {@link WebviewError} (`WEBVIEW_ERROR_INVALID_ARGUMENT`) and
   * answers nothing. Windows sends every pair as its own header line; macOS
   * (`NSHTTPURLResponse`) joins repeated names with `", "` and keeps only the
   * first `Set-Cookie`, so at most one `Set-Cookie` per response there.
   */
  headers?: Record<string, string> | [name: string, value: string][];
  /** The body; a string is encoded as UTF-8. */
  body?: Uint8Array | ArrayBuffer | string | null;
}

/**
 * Answers a {@link WebviewRequest}: return (or resolve to) a
 * {@link WebviewResponse} and it is sent, or return nothing and call
 * {@link Webview.completeRequest} with `request.id` later. A handler that
 * throws or rejects answers 500.
 */
export type RequestHandler = (
  request: WebviewRequest,
) => WebviewResponse | void | Promise<WebviewResponse | void>;

function responseBodyBytes(body: WebviewResponse["body"]): Uint8Array | null {
  if (body == null) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return body;
}

/**
 * Answers a request handed to a {@link Webview.setRequestHandler request handler},
 * given the webview's {@link Webview.unsafeHandle}. Safe to call from any
 * thread: this is how a `Worker` answers requests while {@link Webview.run}
 * blocks the thread that owns the webview. Post the handle and the request
 * to the worker, then call this there. The headers and body are copied before
 * this returns. Completing a request twice, or one the browser has since
 * cancelled, does nothing.
 *
 * Safe against the webview being destroyed on another thread: once
 * {@link Webview.destroy} has begun this throws a {@link WebviewError}
 * (`WEBVIEW_ERROR_INVALID_STATE`, code -3) instead of touching freed memory,
 * and an answer queued just before then does nothing. Still stop the worker
 * before destroying the webview, so it does not keep answering into nothing.
 *
 * @param handle The webview's {@link Webview.unsafeHandle}.
 * @param id The request's {@link WebviewRequest.id}.
 * @throws {WebviewError} Bad headers (see {@link WebviewResponse.headers}),
 * a status outside 100-599, a body over 4 GiB - 1, or a destroyed webview.
 */
export function completeWebviewRequest(
  handle: Pointer,
  id: bigint,
  response: WebviewResponse = {},
) {
  const status = response.status ?? 200;
  // Bound before any buffer is made, and the buffers are passed as typed
  // arrays (never a numeric ptr(...)), so nothing can collect them before
  // the library has copied them.
  const symbols = (requestLib ??= openRequestLib()).symbols;
  const headers = response.headers
    ? encodeCString(JSON.stringify(response.headers))
    : null;
  const body = responseBodyBytes(response.body);
  const hasBody = body !== null && body.byteLength > 0;
  check(
    "webview_complete_request",
    symbols.webview_complete_request(
      handle,
      id,
      status,
      headers,
      hasBody ? body : null,
      BigInt(hasBody ? body.byteLength : 0),
    ),
  );
}

/** The head of a streamed answer (see {@link beginWebviewResponse}). */
export interface WebviewResponseHead {
  /** HTTP status code, 100 to 599. Defaults to 200. */
  status?: number;
  /** Response headers, exactly as {@link WebviewResponse.headers}. */
  headers?: WebviewResponse["headers"];
}

/**
 * Starts a streamed answer to a {@link WebviewRequest}, given the webview's
 * {@link Webview.unsafeHandle}: the status and headers go now, the body
 * follows piece by piece with {@link writeWebviewResponseChunk}, and
 * {@link endWebviewResponse} ends it, with no socket. Use instead of
 * {@link completeWebviewRequest}, never both for one request.
 *
 * Safe to call from any thread, like {@link completeWebviewRequest}: a
 * `Worker` streams while {@link Webview.run} blocks the webview's thread.
 *
 * Windows: the body is an `IStream` WebView2 reads on its own thread, but
 * WebView2 hands the page the response only once the whole body is read (a
 * WebView2 limitation for intercepted requests), so an `EventSource` there
 * gets every event at {@link endWebviewResponse}, not one by one. macOS:
 * `didReceiveResponse:` / `didReceiveData:` / `didFinish` on the
 * `WKURLSchemeTask`, which the page reads as it arrives. Linux: accepted;
 * does nothing.
 *
 * @throws {WebviewError} Bad headers, a status outside 100-599, a response
 * already begun for this request (`WEBVIEW_ERROR_DUPLICATE`, Windows), or a
 * destroyed webview (`WEBVIEW_ERROR_INVALID_STATE`, code -3).
 */
export function beginWebviewResponse(
  handle: Pointer,
  id: bigint,
  head: WebviewResponseHead = {},
) {
  const symbols = (streamLib ??= openStreamLib()).symbols;
  const headers = head.headers
    ? encodeCString(JSON.stringify(head.headers))
    : null;
  check(
    "webview_begin_response",
    symbols.webview_begin_response(handle, id, head.status ?? 200, headers),
  );
}

/**
 * Appends a piece of the body to a response started with
 * {@link beginWebviewResponse}. Safe to call from any thread; the bytes are
 * copied before this returns. A chunk for a response that has ended, was
 * never begun, or that the page abandoned is dropped; an empty chunk does
 * nothing.
 *
 * @param chunk The bytes; a string is encoded as UTF-8.
 * @throws {WebviewError} A chunk over 4 GiB - 1, or a destroyed webview
 * (`WEBVIEW_ERROR_INVALID_STATE`, code -3).
 */
export function writeWebviewResponseChunk(
  handle: Pointer,
  id: bigint,
  chunk: Uint8Array | ArrayBuffer | string,
) {
  const symbols = (streamLib ??= openStreamLib()).symbols;
  // Passed as a typed array (never a numeric ptr(...)), so it stays alive
  // until the library has copied it.
  const bytes = responseBodyBytes(chunk)!;
  if (bytes.byteLength === 0) return;
  check(
    "webview_write_response_chunk",
    symbols.webview_write_response_chunk(
      handle,
      id,
      bytes,
      BigInt(bytes.byteLength),
    ),
  );
}

/**
 * Ends a response started with {@link beginWebviewResponse}; the page sees
 * the end once it has read every chunk written before. Safe to call from any
 * thread. Ending twice, or a response never begun, does nothing.
 *
 * @throws {WebviewError} A destroyed webview (`WEBVIEW_ERROR_INVALID_STATE`,
 * code -3).
 */
export function endWebviewResponse(handle: Pointer, id: bigint) {
  check(
    "webview_end_response",
    (streamLib ??= openStreamLib()).symbols.webview_end_response(handle, id),
  );
}

/**
 * Receives the real filesystem paths of files dropped on the webview from
 * the operating system (see {@link Webview.setFileDropHandler}).
 */
export type FileDropHandler = (paths: string[]) => void;

/** Window size */
export interface Size {
  /** The width of the window */
  width: number;
  /** The height of the window */
  height: number;
  /** The window size hint */
  hint: SizeHint;
}

/** Window size hints */
export const enum SizeHint {
  /** Width and height are default size */
  NONE,
  /** Width and height are minimum bounds */
  MIN,
  /** Width and height are maximum bounds */
  MAX,
  /** Window size can not be changed by a user */
  FIXED,
}

/** An instance of a webview window.*/
export class Webview {
  #handle: Pointer | null = null;
  #callbacks: Map<string, JSCallback> = new Map();
  #requestCallback: JSCallback | null = null;
  #fileDropCallback: JSCallback | null = null;

  /** **UNSAFE**: Highly unsafe API, beware!
   *
   * An unsafe pointer to the webview
   */
  get unsafeHandle() {
    return this.#handle;
  }

  /** **UNSAFE**: Highly unsafe API, beware!
   *
   * An unsafe pointer to the webviews platform specific native window handle.
   * When using GTK backend the pointer is `GtkWindow` pointer, when using Cocoa
   * backend the pointer is `NSWindow` pointer, when using Win32 backend the
   * pointer is `HWND` pointer.
   */
  get unsafeWindowHandle() {
    return lib.symbols.webview_get_window(this.#handle);
  }

  /**
   * Sets the native window size
   *
   * ## Example
   *
   * ```ts
   * import { Webview, SizeHint } from "@n1h/sweetview-webview-bun";
   *
   * const webview = new Webview();
   * webview.navigate("https://bun.sh/");
   *
   * // Change from the default size to a small fixed window
   * webview.size = {
   *   width: 200,
   *   height: 200,
   *   hint: SizeHint.FIXED
   * };
   *
   * webview.run();
   * ```
   */
  set size({ width, height, hint }: Size) {
    //@ts-ignore
    lib.symbols.webview_set_size(this.#handle, width, height, hint);
  }

  /**
   * Sets the native window title
   *
   * ## Example
   *
   * ```ts
   * import { Webview } from "@n1h/sweetview-webview-bun";
   *
   * const webview = new Webview();
   * webview.navigate("https://bun.sh/");
   *
   * // Set the window title to "Hello world!"
   * webview.title = "Hello world!";
   *
   * webview.run();
   * ```
   */
  set title(title: string) {
    lib.symbols.webview_set_title(this.#handle, encodeCString(title));
  }

  /** **UNSAFE**: Highly unsafe API, beware!
   *
   * Creates a new webview instance from a webview handle.
   *
   * @param handle A previously created webview instances handle
   */
  constructor(handle: Pointer);
  /**
   * Creates a new webview instance.
   *
   * ## Example
   *
   * ```ts
   * import { Webview, SizeHint } from "@n1h/sweetview-webview-bun";
   *
   * // Create a new webview and change from the default size to a small fixed window
   * const webview = new Webview(true, {
   *   width: 200,
   *   height: 200,
   *   hint: SizeHint.FIXED
   * });
   *
   * webview.navigate("https://bun.sh/");
   * webview.run();
   * ```
   *
   * @param debug Defaults to false, when true developer tools are enabled
   * for supported platforms
   * @param size The window size, default to 1024x768 with no size hint. Set
   * this to undefined if you do not want to automatically resize the window.
   * This may cause issues for MacOS where the window is invisible until
   * resized.
   * @param window **UNSAFE**: Highly unsafe API, beware! An unsafe pointer to
   * the platforms specific native window handle. If null or undefined a new
   * window is created. If it's non-null - then child WebView is embedded into
   * the given parent window. Otherwise a new window is created. Depending on
   * the platform, a `GtkWindow`, `NSWindow` or `HWND` pointer can be passed
   * here.
   */
  constructor(debug?: boolean, size?: Size, window?: Pointer | null);
  constructor(
    debugOrHandle: boolean | Pointer = false,
    size: Size | undefined = {
      width: 1024,
      height: 768,
      hint: SizeHint.NONE,
    },
    window: Pointer | null = null,
  ) {
    this.#handle =
      typeof debugOrHandle === "bigint" || typeof debugOrHandle === "number"
        ? debugOrHandle
        : (lib.symbols.webview_create(
            Number(debugOrHandle),
            window,
          ) as Pointer | null);
    if (size !== undefined) this.size = size;
    instances.push(this);
  }

  /**
   * Destroys the webview and closes the window along with freeing all internal
   * resources.
   */
  destroy() {
    if (!this.#handle) return;
    for (const callback of this.#callbacks.keys()) this.unbind(callback);
    // Unregister the request handler before the library can call it again;
    // its JSCallback is freed only once the webview is gone. Requests still
    // open are answered by webview_destroy (Windows: 503; macOS: released).
    if (this.#requestCallback) {
      (requestLib ??= openRequestLib()).symbols.webview_set_request_handler(
        this.#handle,
        null,
        null,
      );
    }
    // Likewise the file drop handler.
    if (this.#fileDropCallback) {
      (streamLib ??= openStreamLib()).symbols.webview_set_file_drop_handler(
        this.#handle,
        null,
        null,
      );
    }
    lib.symbols.webview_terminate(this.#handle);
    lib.symbols.webview_destroy(this.#handle);
    this.#handle = null;
    this.#requestCallback?.close();
    this.#requestCallback = null;
    this.#fileDropCallback?.close();
    this.#fileDropCallback = null;
  }

  /**
   * Navigates webview to the given URL. URL may be a data URI, i.e.
   * `"data:text/html,<html>...</html>"`. It is often ok not to url-encodeCString it
   * properly, webview will re-encodeCString it for you.
   */
  navigate(url: string) {
    lib.symbols.webview_navigate(this.#handle, encodeCString(url));
  }

  /**
   * Sets the current HTML of the webview to the given html string.
   */
  setHTML(html: string) {
    lib.symbols.webview_set_html(this.#handle, encodeCString(html));
  }

  /**
   * Serves bytes at a path of the webview's own origin, so the page can be
   * loaded with {@link Webview.navigate} instead of {@link Webview.setHTML}
   * (which Windows caps at 2 MB) and can fetch scripts, styles, images and
   * models by relative URL. Nothing reaches the network. The bytes are copied;
   * calling again with the same path replaces them.
   *
   * The origin is `http://webview.localhost` on Windows and
   * `webview://localhost` on macOS; {@link Webview.assetOrigin} is the one for
   * this platform. On Linux the asset is stored and not served.
   *
   * @param path URL path without the leading slash, for example `index.html`
   * or `js/main.js`. A request's query string and fragment are ignored when
   * matching. Must not need percent-encoding.
   * @param mime The `Content-Type` header, for example
   * `text/html; charset=utf-8`.
   * @param data The bytes; a string is encoded as UTF-8.
   */
  setAsset(path: string, mime: string, data: Uint8Array | string) {
    // Bound first; every buffer goes in as a typed array, which Bun keeps
    // alive for the call (see encodeCString).
    const symbols = (forkLib ??= openForkLib()).symbols;
    const bytes =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    const pathBuf = encodeCString(path);
    const mimeBuf = encodeCString(mime);
    check(
      "webview_set_asset",
      symbols.webview_set_asset(
        this.#handle,
        pathBuf,
        mimeBuf,
        bytes.byteLength > 0 ? bytes : null,
        BigInt(bytes.byteLength),
      ),
    );
  }

  /**
   * The origin {@link Webview.setAsset} serves at on this platform; navigate to
   * `${webview.assetOrigin}/index.html`.
   */
  get assetOrigin(): string {
    return process.platform === "win32"
      ? "http://webview.localhost"
      : "webview://localhost";
  }

  /**
   * A second origin, cross-origin from {@link Webview.assetOrigin}, for
   * content the page must not reach into, such as a sandboxed `<iframe>`.
   * Every request to it goes to the {@link Webview.setRequestHandler request handler}.
   * `http://frames.webview.localhost` on Windows, `webview-frames://localhost`
   * on macOS. Nothing reaches the network.
   */
  get framesOrigin(): string {
    return process.platform === "win32"
      ? "http://frames.webview.localhost"
      : "webview-frames://localhost";
  }

  /**
   * Answers requests in code instead of from fixed bytes: every request to
   * {@link Webview.assetOrigin} that no {@link Webview.setAsset asset}
   * matches (assets still answer first), and every request to
   * {@link Webview.framesOrigin}. Nothing reaches the network and no socket
   * is opened. Without a handler those requests answer 404.
   *
   * The handler runs on the thread that runs the webview, inside
   * {@link Webview.run}. It must not block. Return a
   * {@link WebviewResponse} to send it, or return nothing and answer later
   * with {@link Webview.completeRequest} or, from a `Worker`,
   * {@link completeWebviewRequest}; a handler that throws answers 500.
   * Requests stay open until answered, and the browser waits for them.
   *
   * A returned promise is answered when it settles (500 if it rejects), but
   * promises settle only when the thread's event loop turns, and
   * {@link Webview.run} blocks it: Bun does not run microtasks, timers or I/O
   * on that thread until `run()` returns. For work that needs `await`, post
   * the request to a `Worker` and answer it there with
   * {@link completeWebviewRequest}.
   *
   * Pass `null` to remove the handler; requests already handed to it stay
   * open until completed or until the webview is destroyed. Destroying it
   * answers them `503` on Windows; on macOS the tasks are released unanswered
   * and WebKit stops them.
   *
   * Windows: WebView2's `WebResourceRequested`, deferred until completed;
   * requests from service workers are caught too (WebView2 Runtime 125 or
   * later). macOS: a `WKURLSchemeHandler` for the schemes `webview` and
   * `webview-frames`. Linux: accepted; not served.
   *
   * ## Example
   *
   * Synchronous, so it works while {@link Webview.run} blocks the thread:
   *
   * ```ts
   * webview.setRequestHandler((req) => {
   *   const { pathname } = new URL(req.url);
   *   if (pathname === "/api/time") {
   *     return {
   *       headers: { "Content-Type": "application/json" },
   *       body: JSON.stringify({ now: Date.now() }),
   *     };
   *   }
   *   return { status: 404 };
   * });
   * webview.navigate(`${webview.assetOrigin}/index.html`);
   * ```
   *
   * For async work (`fetch`, files, a database), return nothing, post
   * `{ handle: webview.unsafeHandle, request }` to a `Worker`, and answer
   * there with {@link completeWebviewRequest}; see `docs/requests.md`.
   */
  setRequestHandler(handler: RequestHandler | null) {
    const symbols = (requestLib ??= openRequestLib()).symbols;
    const previous = this.#requestCallback;
    if (!handler) {
      check(
        "webview_set_request_handler",
        symbols.webview_set_request_handler(this.#handle, null, null),
      );
      this.#requestCallback = null;
      previous?.close();
      return;
    }
    const callback = new JSCallback(
      (
        id: bigint,
        methodPtr: Pointer | null,
        urlPtr: Pointer | null,
        headersPtr: Pointer | null,
        bodyPtr: Pointer | null,
        bodyLen: bigint,
      ) => {
        let request: WebviewRequest;
        try {
          const length = Number(bodyLen);
          request = {
            id: BigInt(id),
            method: methodPtr ? new CString(methodPtr).toString() : "GET",
            url: urlPtr ? new CString(urlPtr).toString() : "",
            headers: headersPtr
              ? JSON.parse(new CString(headersPtr).toString())
              : [],
            // Copied: the pointer is valid only during this call.
            body:
              bodyPtr && length > 0
                ? new Uint8Array(toArrayBuffer(bodyPtr, 0, length)).slice()
                : null,
          };
        } catch {
          this.#completeQuietly(BigInt(id), { status: 500 });
          return;
        }
        let result: ReturnType<RequestHandler>;
        try {
          result = handler(request);
        } catch {
          this.#completeQuietly(request.id, { status: 500 });
          return;
        }
        if (result instanceof Promise) {
          result.then(
            (response) => {
              if (response) this.#completeQuietly(request.id, response);
            },
            () => this.#completeQuietly(request.id, { status: 500 }),
          );
        } else if (result) {
          this.#completeQuietly(request.id, result);
        }
      },
      {
        args: [
          FFIType.u64,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.u64,
          FFIType.ptr,
        ],
        returns: FFIType.void,
      },
    );
    const code = symbols.webview_set_request_handler(
      this.#handle,
      callback.ptr,
      null,
    );
    if (code !== 0) {
      callback.close();
      throw new WebviewError("webview_set_request_handler", code);
    }
    this.#requestCallback = callback;
    previous?.close();
  }

  /**
   * Answers a request handed to the {@link Webview.setRequestHandler request handler}.
   * Safe to call from any thread, including after the handler returned. The
   * headers are checked and the headers and body copied before this returns.
   * Completing a request twice, or one the browser has since cancelled, does
   * nothing.
   *
   * A response refused here leaves the request open, so it can still be
   * answered; compare a response returned from the handler, which becomes a
   * 500 instead (see `docs/requests.md`).
   *
   * @param id The request's {@link WebviewRequest.id}.
   * @throws {WebviewError} Bad headers (see {@link WebviewResponse.headers}),
   * a status outside 100-599, a body over 4 GiB - 1, or a webview already
   * destroyed (`WEBVIEW_ERROR_INVALID_STATE`, code -3), as
   * {@link completeWebviewRequest} does.
   */
  completeRequest(id: bigint, response: WebviewResponse = {}) {
    if (!this.#handle) {
      // Same answer the library gives completeWebviewRequest on a destroyed
      // handle: WEBVIEW_ERROR_INVALID_STATE.
      throw new WebviewError("webview_complete_request", -3);
    }
    completeWebviewRequest(this.#handle, id, response);
  }

  /**
   * Starts a streamed answer to a request handed to the
   * {@link Webview.setRequestHandler request handler}; see
   * {@link beginWebviewResponse}, which a `Worker` calls with
   * {@link Webview.unsafeHandle}.
   */
  beginResponse(id: bigint, head: WebviewResponseHead = {}) {
    beginWebviewResponse(this.#liveHandle("webview_begin_response"), id, head);
  }

  /** Appends a body chunk; see {@link writeWebviewResponseChunk}. */
  writeResponseChunk(id: bigint, chunk: Uint8Array | ArrayBuffer | string) {
    writeWebviewResponseChunk(
      this.#liveHandle("webview_write_response_chunk"),
      id,
      chunk,
    );
  }

  /** Ends a streamed answer; see {@link endWebviewResponse}. */
  endResponse(id: bigint) {
    endWebviewResponse(this.#liveHandle("webview_end_response"), id);
  }

  // The handle, or the library's answer for a destroyed one:
  // WEBVIEW_ERROR_INVALID_STATE.
  #liveHandle(fn: string): Pointer {
    if (!this.#handle) throw new WebviewError(fn, -3);
    return this.#handle;
  }

  /**
   * Receives the real filesystem paths of files dropped on the webview from
   * the operating system (Explorer, Finder). While a handler is set, a drop
   * of files is taken from the page: the browser does not open the dropped
   * file, and the handler gets every path. Drags inside the page, and drags
   * that carry no files, are untouched. Pass `null` to hand drops back to the
   * page. Runs on the webview's thread, inside {@link Webview.run}.
   *
   * Windows: the drop's `File` objects go to the host with
   * `chrome.webview.postMessageWithAdditionalObjects`, whose
   * `ICoreWebView2File` gives each path (WebView2 Runtime 113 or later, with
   * external drop allowed; see {@link Webview.setAllowExternalDrop}). macOS:
   * the `WKWebView` takes drags whose pasteboard holds file URLs. Linux:
   * accepted; does nothing.
   */
  setFileDropHandler(handler: FileDropHandler | null) {
    const symbols = (streamLib ??= openStreamLib()).symbols;
    const previous = this.#fileDropCallback;
    if (!handler) {
      check(
        "webview_set_file_drop_handler",
        symbols.webview_set_file_drop_handler(this.#handle, null, null),
      );
      this.#fileDropCallback = null;
      previous?.close();
      return;
    }
    const callback = new JSCallback(
      (pathsPtr: Pointer | null) => {
        let paths: string[];
        try {
          paths = pathsPtr ? JSON.parse(new CString(pathsPtr).toString()) : [];
        } catch {
          return;
        }
        try {
          handler(paths);
        } catch {
          // Nothing may unwind into the library.
        }
      },
      { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    );
    const code = symbols.webview_set_file_drop_handler(
      this.#handle,
      callback.ptr,
      null,
    );
    if (code !== 0) {
      callback.close();
      throw new WebviewError("webview_set_file_drop_handler", code);
    }
    this.#fileDropCallback = callback;
    previous?.close();
  }

  // For responses produced from the handler: a bad response becomes a 500
  // rather than an exception thrown into the library's callback.
  #completeQuietly(id: bigint, response: WebviewResponse) {
    try {
      this.completeRequest(id, response);
    } catch {
      try {
        this.completeRequest(id, { status: 500 });
      } catch {
        // The webview is gone; nothing to answer.
      }
    }
  }

  /**
   * Sets whether files and other content dragged from outside the app can be
   * dropped on the page. Allowed by default. Windows:
   * `ICoreWebView2Controller4::AllowExternalDrop`. macOS, Linux: accepted;
   * does nothing.
   */
  setAllowExternalDrop(allow: boolean) {
    check(
      "webview_set_allow_external_drop",
      (requestLib ??= openRequestLib()).symbols.webview_set_allow_external_drop(
        this.#handle,
        allow ? 1 : 0,
      ),
    );
  }

  /**
   * Sets the color the browser paints behind the page, each channel 0 to 255.
   * With `a` 0 and a page whose own background is transparent, the native
   * window shows through.
   *
   * Windows: `ICoreWebView2Controller2::DefaultBackgroundColor`; for true
   * transparency the host window also needs DWM composition that honors alpha.
   * macOS: `drawsBackground` off on the `WKWebView`, the window non-opaque with
   * this color behind it. Linux: accepted; does nothing.
   */
  setBackgroundColor(r: number, g: number, b: number, a: number) {
    (forkLib ??= openForkLib()).symbols.webview_set_background_color(
      this.#handle,
      r,
      g,
      b,
      a,
    );
  }

  /**
   * Runs the main event loop until it's terminated. After this function exits
   * the webview is automatically destroyed.
   */
  run() {
    lib.symbols.webview_run(this.#handle);
    this.destroy();
  }

  /**
   * Binds a callback so that it will appear in the webview with the given name
   * as a global async JavaScript function. Callback receives a seq and req value.
   * The seq parameter is an identifier for using {@link Webview.return} to
   * return a value while the req parameter is a string of an JSON array representing
   * the arguments passed from the JavaScript function call.
   *
   * @param name The name of the bound function
   * @param callback A callback which takes two strings as parameters: `seq`
   * and `req` and the passed {@link arg} pointer
   * @param arg A pointer which is going to be passed to the callback once called
   */
  bindRaw(
    name: string,
    callback: (seq: string, req: string, arg: Pointer | null) => void,
    arg: Pointer | null = null,
  ) {
    const callbackResource = new JSCallback(
      (seqPtr: Pointer, reqPtr: Pointer, arg: Pointer | null) => {
        const seq = seqPtr ? new CString(seqPtr) : "";
        const req = reqPtr ? new CString(reqPtr) : "";
        //@ts-ignore
        callback(seq, req, arg);
      },
      {
        args: [FFIType.pointer, FFIType.pointer, FFIType.pointer],
        returns: FFIType.void,
      },
    );
    this.#callbacks.set(name, callbackResource);
    lib.symbols.webview_bind(
      this.#handle,
      encodeCString(name),
      callbackResource.ptr,
      arg,
    );
  }

  /**
   * Binds a callback so that it will appear in the webview with the given name
   * as a global async JavaScript function. Callback arguments are automatically
   * converted from json to as closely as possible match the arguments in the
   * webview context and the callback automatically converts and returns the
   * return value to the webview.
   *
   * @param name The name of the bound function
   * @param callback A callback which is passed the arguments as called from the
   * webview JavaScript environment and optionally returns a value to the
   * webview JavaScript caller
   *
   * ## Example
   * ```ts
   * import { Webview } from "@n1h/sweetview-webview-bun";
   *
   * const html = `
   *   <html>
   *   <body>
   *     <h1>Hello from bun v${Bun.version}</h1>
   *     <button onclick="press('I was pressed!', 123, new Date()).then(log);">
   *       Press me!
   *     </button>
   *   </body>
   *   </html>
   * `;
   *
   * const webview = new Webview();
   *
   * webview.navigate(`data:text/html,${encodeURIComponent(html)}`);
   *
   * let counter = 0;
   * // Create and bind `press` to the webview javascript instance.
   * // This functions in addition to logging its parameters also returns
   * // a value from bun to webview.
   * webview.bind("press", (a, b, c) => {
   *   console.log(a, b, c);
   *
   *   return { times: counter++ };
   * });
   *
   * // Bind the `log` function in the webview to the parent instances `console.log`
   * webview.bind("log", (...args) => console.log(...args));
   *
   * webview.run();
   * ```
   */
  bind(name: string, callback: (...args: any) => any) {
    this.bindRaw(name, (seq, req) => {
      const args = JSON.parse(req);
      let result;
      let success: boolean;
      try {
        result = callback(...args);
        success = true;
      } catch (err) {
        result = err;
        success = false;
      }
      if (result instanceof Promise) {
        result.then((r) =>
          this.return(seq, success ? 0 : 1, JSON.stringify(r)),
        );
      } else {
        this.return(seq, success ? 0 : 1, JSON.stringify(result));
      }
    });
  }

  /**
   * Unbinds a previously bound function freeing its resource and removing it
   * from the webview JavaScript context.
   *
   * @param name The name of the bound function
   */
  unbind(name: string) {
    //@ts-ignore
    lib.symbols.webview_unbind(this.#handle, encodeCString(name));
    this.#callbacks.get(name)?.close();
    this.#callbacks.delete(name);
  }

  /**
   * Returns a value to the webview JavaScript environment.
   *
   * @param seq The request pointer as provided by the {@link Webview.bindRaw}
   * callback
   * @param status If status is zero the result is expected to be a valid JSON
   * result value otherwise the result is an error JSON object
   * @param result The stringified JSON response
   */
  return(seq: string, status: number, result: string) {
    lib.symbols.webview_return(
      this.#handle,
      encodeCString(seq),
      status,
      encodeCString(result),
    );
  }

  /**
   * Evaluates arbitrary JavaScript code. Evaluation happens asynchronously,
   * also the result of the expression is ignored. Use
   * {@link Webview.bind bindings} if you want to receive notifications about
   * the results of the evaluation.
   */
  eval(source: string) {
    lib.symbols.webview_eval(this.#handle, encodeCString(source));
  }

  /**
   * Injects JavaScript code at the initialization of the new page. Every time
   * the webview will open a the new page - this initialization code will be
   * executed. It is guaranteed that code is executed before window.onload.
   */
  init(source: string) {
    lib.symbols.webview_init(this.#handle, encodeCString(source));
  }
}

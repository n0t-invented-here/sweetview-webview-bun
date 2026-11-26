import { dlopen, FFIType } from "bun:ffi";
import { Webview } from "./webview";

/**
 * A NUL-terminated UTF-8 copy of `value`, to pass straight as an
 * `FFIType.ptr` argument. Returned as the typed array, not a numeric
 * `ptr(...)`: Bun keeps a typed array argument alive for the call, while a
 * bare pointer to a temporary array can be collected (and its memory reused)
 * by any allocation before the call, such as a lazy `dlopen`.
 */
export function encodeCString(value: string): Uint8Array {
  return new TextEncoder().encode(value + "\0");
}

export const instances: Webview[] = [];

/**
 * Destroys every webview instance this process created through `Webview`
 * (instances already destroyed are skipped) and closes the core library
 * handle. Should only be run once all windows are closed.
 *
 * Scope: it closes only the core symbol table. The fork's feature groups
 * (assets and background color, the request handler, streaming, external
 * drop, file drops) and the input hooks and permissions are each opened
 * lazily with their own `dlopen` and are not closed here; installed mouse or
 * keyboard hooks are not removed (dispose them first). Nothing in the
 * package may be called after `unload()`.
 */
export function unload() {
  for (const instance of instances) instance.destroy();
  lib.close();
}

let lib_file;

if (process.env.WEBVIEW_PATH) {
  lib_file = { default: process.env.WEBVIEW_PATH };
} else if (process.platform === "win32") {
  //@ts-expect-error
  lib_file = await import("../build/libwebview.dll");
} else if (process.platform === "linux") {
  lib_file = await import(`../build/libwebview-${process.arch}.so`);
} else if (process.platform === "darwin") {
  //@ts-expect-error
  lib_file = await import("../build/libwebview.dylib");
}

export const lib = dlopen(lib_file.default, {
  webview_create: {
    args: [FFIType.i32, FFIType.ptr],
    returns: FFIType.ptr,
  },
  webview_destroy: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  webview_run: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  webview_terminate: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
  webview_get_window: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
  webview_set_title: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  webview_set_size: {
    args: [FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32],
    returns: FFIType.void,
  },
  webview_navigate: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  webview_set_html: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  webview_init: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  webview_eval: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  webview_bind: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.function, FFIType.ptr],
    returns: FFIType.void,
  },
  webview_unbind: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.void,
  },
  webview_return: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.void,
  },
});

/** The library file `lib` was opened from, for the fork's own functions (src/mouse-hook.ts), which bind lazily so a library without them still loads. */
export const libraryPath: string = lib_file.default;

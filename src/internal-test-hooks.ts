// Inspection hooks for the package's own tests. Not part of the public API:
// src/index.ts does not re-export this module, and src/webview.ts only
// imports from it. Tests import it by path.
import type { Pointer } from "bun:ffi";

let pendingCloses: () => number = () => 0;
const fileDropPtrs = new WeakMap<object, () => Pointer | null>();

/** @internal Called once by src/webview.ts. */
export function registerPendingCallbackCloses(count: () => number) {
  pendingCloses = count;
}

/** @internal Called by src/webview.ts for every Webview it constructs. */
export function registerFileDropCallbackPtr(
  webview: object,
  ptr: () => Pointer | null,
) {
  fileDropPtrs.set(webview, ptr);
}

/** For tests: how many released native callbacks wait to be closed. */
export function pendingCallbackCloses(): number {
  return pendingCloses();
}

/**
 * For tests: the native function pointer of the webview's installed file
 * drop handler callback, so a test can call it as the library would.
 */
export function fileDropCallbackPtr(webview: object): Pointer | null {
  return fileDropPtrs.get(webview)?.() ?? null;
}

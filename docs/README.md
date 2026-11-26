# sweetview-webview-bun documentation

| Page                                              | Covers                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| [The `Webview` class](webview.md)                 | Creating a window, loading content, bindings between bun and the page, running |
| [Assets and background](assets-and-background.md) | `setAsset` (serve files at the webview's own origin), `setBackgroundColor`     |
| [Requests and drops](requests.md)                 | `setRequestHandler`, `completeRequest`, streaming (`beginResponse`, `writeResponseChunk`, `endResponse`, and the worker functions `beginWebviewResponse`, `writeWebviewResponseChunk`, `endWebviewResponse`), `framesOrigin`, `setAllowExternalDrop`, `setFileDropHandler` |
| [Input hooks](input-hooks.md)                     | System-wide mouse and keyboard hooks, the permission model for macOS           |

- Install, build and package instructions: the [README](../README.md).
- The 2.8.0 additions (requests, streaming, drops) are implemented on Windows and macOS; the
  checked-in macOS and Linux binaries predate them (see
  [Shipped binaries](requests.md#shipped-binaries)).
- The C library these bindings wrap: [sweetview-webview](https://github.com/n0t-invented-here/sweetview-webview);
  its additions are documented in its [`sweetview/`](https://github.com/n0t-invented-here/sweetview-webview/tree/sweetview/sweetview) folder.

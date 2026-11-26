# sweetview-webview-bun

[bun](https://bun.sh/) bindings for [sweetview-webview](https://github.com/n0t-invented-here/sweetview-webview), a fork of [webview](https://github.com/webview/webview/): **web-based GUIs for desktop applications**.

![](banner.png)

Forked from [webview-bun](https://github.com/tr1ckydev/webview-bun), same API, plus what the
sweetview fork of the library adds:

- `Webview.setAsset`: serve bytes at the webview's own origin, so pages load by `navigate` and
  fetch by relative URL.
- `Webview.setRequestHandler`: answer the page's requests in code, with no socket, and
  `framesOrigin`, a second origin for cross-origin `<iframe>`s.
- Streamed responses: `Webview.beginResponse`, `writeResponseChunk`, `endResponse` (and
  `beginWebviewResponse`, `writeWebviewResponseChunk`, `endWebviewResponse` for workers): status
  and headers now, the body in chunks.
- `Webview.setAllowExternalDrop`: refuse drops from outside the app (Windows and macOS).
- `Webview.setFileDropHandler`: the real filesystem paths of files dropped from the OS (Windows and
  macOS).
- `Webview.setBackgroundColor`: a color, or transparency, behind the page.
- System-wide mouse and keyboard hooks, with a permission model for macOS.

Every API is documented under [`docs/`](docs/).

The fork's additions are implemented on Windows and macOS. On Linux the calls exist (the library
keeps upstream webview/webview's C ABI) and are accepted without effect, except the input hooks,
which throw.

> [!IMPORTANT]
> `build/libwebview.dll` and `build/libwebview.dylib` are built from current source.
> `build/libwebview-x64.so` predates the 2.8.0 additions (request handler, streaming, external drop,
> file drops), none of which Linux implements. See
> [Shipped binaries](docs/requests.md#shipped-binaries).

## Installation

<details>
  <summary>Click here for instructions on 🐧 Linux</summary>
  The compiled linux library in this package requires GTK 4 and WebkitGTK 6.

> To use a different version, see Development section below.

- Debian-based systems: `sudo apt install libgtk-4-1 libwebkitgtk-6.0-4`
- Arch-based systems: `sudo pacman -S gtk4 webkitgtk-6.0`
- Fedora-based systems: `sudo dnf install gtk4 webkitgtk6.0`

</details>

<details>
  <summary>Click here for instructions on 🪟 Windows</summary>
  The compiled Windows library in this package does not bundle the WebView2 Runtime: it always uses the one installed on the system. (The `WEBVIEW_MSWEBVIEW2_VERSION` build option in the Development section picks the WebView2 SDK headers the library is compiled against, not a Runtime to ship.)

The <a href="https://developer.microsoft.com/en-us/microsoft-edge/webview2/">Microsoft Edge WebView2</a> runtime is required to be installed on the system for any version of Windows before Windows 11.
To manually update or install the latest version, follow the steps <a href="https://github.com/MicrosoftEdge/WebView2Feedback/issues/3371#issuecomment-1500917825">here</a>.

</details>

```bash
bun i @n1h/sweetview-webview-bun
```

## Example

```typescript
import { Webview } from "@n1h/sweetview-webview-bun";

const html = `
<html>
    <body>
        <h1>Hello from bun v${Bun.version} !</h1>
    </body>
</html>
`;

const webview = new Webview();

webview.setHTML(html);
webview.run();
```

For more examples, browse the `examples` folder of this repository.

## Single-file executable

You can compile a single self-sufficient executable file for your webview app.

For example, let's create a single executable for the above To-Do app. Clone this repository and run,

```bash
bun build --compile --minify --sourcemap ./examples/todoapp/app.ts --outfile todoapp
```

> [!TIP]
> By default, a terminal window will also open in the back when double-click opening the executable in Windows and macOS.
>
> #### 🪟 To hide it in Windows:
>
> Run [`bun scripts/hidecmd.ts`](scripts/hidecmd.ts), give it the exe path when prompted, and it marks the executable as a GUI program.
>
> #### 🍎 To hide it in macOS:
>
> Naming the output `something.app` does not make an app bundle: it is still a single executable file, and Finder still opens it in Terminal. Put the executable in a real bundle instead (`MyApp.app/Contents/MacOS/MyApp` plus a `MyApp.app/Contents/Info.plist` whose `CFBundleExecutable` is `MyApp`).

### Cross-platform compilation

Bun now supports cross-compilation of single executable binaries. To cross compile your webview app for a different platform run,

```bash
bun build --compile --target=bun-windows-x64 --minify --sourcemap ./examples/todoapp/app.ts --outfile todoapp
```

See [full list](https://github.com/oven-sh/bun/blob/main/docs/bundler/executables.md#supported-targets) of supported targets.

### Bun.serve with webview

`webview.run()` blocks the thread it is called on until the window closes, so a `Bun.serve` on that thread would never answer. Keep the webview on the main thread (its UI thread) and run the server in a `Worker`, as [examples/webserver](examples/webserver) does: `index.ts` starts `worker.ts` (the `Bun.serve`) and then opens the window. Clone this repository then,

```bash
cd examples/webserver/
bun build --compile --minify --sourcemap ./index.ts ./worker.ts --outfile webserver
```

### Extras

🪟 On windows, to add an icon to your exe file, checkout [rcedit](https://github.com/electron/rcedit).

🍎 On macOS, to codesign your executable checkout the [bun docs](https://bun.sh/docs/bundler/executables#code-signing-on-macos).

## Documentation

| Page                                                   | Covers                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [The `Webview` class](docs/webview.md)                 | Creating a window, loading content, bindings between bun and the page, running |
| [Assets and background](docs/assets-and-background.md) | `setAsset` (serve files at the webview's own origin), `setBackgroundColor`     |
| [Requests and drops](docs/requests.md)                 | `setRequestHandler`, `completeRequest`, streaming (`beginResponse`, `writeResponseChunk`, `endResponse` and their worker functions), `framesOrigin`, `setAllowExternalDrop`, `setFileDropHandler` |
| [Input hooks](docs/input-hooks.md)                     | System-wide mouse and keyboard hooks, the permission model for macOS           |

[`docs/`](docs/) has the same list. Each member is also documented where it is declared, in `src/`.

## Development

Please use `bun pretty` to automatically format all files.

### Building the shipped library

`just build` ([just](https://github.com/casey/just), pwsh) fetches the `webview/` submodule if it is empty, builds the library for this OS and copies it to `build/` (`libwebview.dll`, `libwebview.dylib`, or `libwebview-<arch>.so`), where [`src/ffi.ts`](src/ffi.ts) imports it from and the npm package ships it. On Windows it enters the Visual Studio dev shell from pwsh and runs CMake with ninja itself, no `cmd` or `.bat`; elsewhere it runs `bun scripts/build.ts`. Commit the result in `build/` so the published package carries it. `just pack` shows what `npm publish` would upload; `just publish` publishes.

### Prerequisites

#### 🪟 On **Windows,** you need C++ Build Tools, CMake, Ninja, just and PowerShell 7:

- Go to https://visualstudio.microsoft.com/downloads.
- Scroll down > _All Downloads_ > _Tools for Visual Studio_.
- Download _Build Tools for Visual Studio 2022_ (or later) and run.
- Select _Desktop development with C++_ and install.
- CMake and Ninja on `PATH`: `winget install Kitware.CMake Ninja-build.Ninja`.
- [just](https://github.com/casey/just) and `pwsh`: `winget install Casey.Just Microsoft.PowerShell`.

#### 🐧 On linux, you need following deps:

- Debian-based: `sudo apt install libgtk-4-dev libwebkitgtk-6.0-dev cmake ninja-build clang`
- Fedora-based: `sudo dnf install gtk4-devel webkitgtk6.0-devel cmake ninja-build clang`
- Arch-based: `sudo pacman -S cmake ninja clang`

#### 🍎 On macOS, you need the Xcode Command Line Tools, CMake and Ninja:

```bash
xcode-select --install
brew install cmake ninja
```

The dylib is built with Apple Clang (`/usr/bin/clang`) whatever `clang` is first on `PATH`, as a
universal binary (arm64 + x86_64) for macOS 11.0 and later.

### Building

- Clone the repository along with the [webview](https://github.com/webview/webview) submodule.

  ```bash
  git clone --recurse-submodules --branch sweetview https://github.com/n0t-invented-here/sweetview-webview-bun
  cd sweetview-webview-bun
  ```

- Build the library for your platform.

  > Under the hood, it invokes webview's own cmake build system to compile the shared library file.

  ```bash
  just build
  ```

  On Windows use `just build`: it enters the Visual Studio dev shell and runs CMake with Ninja.
  `bun run build` (`scripts/build.ts`) works on macOS and Linux only; on Windows it stops with
  "on Windows, build with `just build`".

- (Optional) Clear build cache and rebuild the library.

  ```bash
  just clean
  just build
  ```

The compiled library file can be found inside the `build` folder.

### Customization

- 🐧 For linux, if you want to use a different WebkitGTK version, change the cmake `WEBVIEW_WEBKITGTK_API` option in _build.ts_ to one of the [available values](https://github.com/webview/webview?tab=readme-ov-file#linux-specific-options). Be sure to first install the corresponding version libraries.
- 🪟 For Windows, the cmake `WEBVIEW_MSWEBVIEW2_VERSION` option selects which WebView2 SDK (the `Microsoft.Web.WebView2` NuGet package's headers, by its [version string](https://www.nuget.org/packages/Microsoft.Web.WebView2/#versions-body-tab)) the library is compiled against. It does not bundle a WebView2 Runtime: the library always runs on the Runtime installed on the system.

Check out the [webview build docs](https://github.com/webview/webview?tab=readme-ov-file#customization) for more options.

### Running

> [!TIP]
> To use your own webview library, set the `WEBVIEW_PATH` environment variable with the path to your webview shared library file.

Run the following example to see it in action.

```bash
bun run examples/basic.ts
```

For more examples, browse the `examples` folder of this repository.

## Credits

This repository is a port of [webview_deno](https://github.com/webview/webview_deno) with various changes to work with the bun runtime.

## License

This repository uses MIT license. See [LICENSE](https://github.com/tr1ckydev/webview-bun/blob/main/LICENSE) for full license text.

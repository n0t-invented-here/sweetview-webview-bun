import { $ } from "bun";

// Every step must succeed: a failed configure, build, copy or strip ends the
// script with that step's exit code, so `just build` never goes on to accept
// a library left in build/ by an earlier run.
$.throws(true);

const { arch, platform } = process;

// The oldest macOS the shipped libwebview.dylib must load on.
const MACOS_DEPLOYMENT_TARGET = "11.0";

const configureFlags = [
  "-DWEBVIEW_ENABLE_CHECKS=false",
  "-DWEBVIEW_BUILD_AMALGAMATION=false",
  "-DWEBVIEW_BUILD_EXAMPLES=false",
  "-DWEBVIEW_BUILD_STATIC_LIBRARY=false",
  "-DWEBVIEW_BUILD_TESTS=false",
];

async function build(platformFlags: string[], built: string, shipped: string, strip: string[]) {
  await $`cmake -G ${"Ninja Multi-Config"} -B build -S . ${platformFlags} ${configureFlags}`.cwd("webview");
  await $`cmake --build build --config Release`.cwd("webview");
  await $`cp ${built} ${shipped}`.cwd("webview");
  await $`strip ${strip} ${shipped}`.cwd("webview");
}

try {
  switch (platform) {
    case "win32":
      // The justfile's build recipe enters the Visual Studio dev shell from pwsh and runs CMake itself.
      console.error("on Windows, build with `just build`");
      process.exit(1);
    case "linux":
      await build(
        ["-DCMAKE_TOOLCHAIN_FILE=cmake/toolchains/host-llvm.cmake", "-DWEBVIEW_WEBKITGTK_API=6.0"],
        "build/core/Release/libwebview.so",
        `../build/libwebview-${arch}.so`,
        [],
      );
      break;
    case "darwin":
      // The shipped dylib is built with the system toolchain (Apple Clang and
      // the SDK's libc++ headers), not whichever `clang` is first on PATH, and
      // for macOS 11.0, the oldest macOS that runs on arm64 and the
      // LSMinimumSystemVersion sweetview's app bundles declare. A newer LLVM's
      // libc++ headers make the library import symbols only the newest macOS
      // has (std::__hash_memory), and with no deployment target it declares
      // the build machine's macOS as its minimum; either way it would not load
      // on an older system.
      await build(
        [
          "-DCMAKE_C_COMPILER=/usr/bin/clang",
          "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
          "-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64",
          `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_DEPLOYMENT_TARGET}`,
        ],
        "build/core/Release/libwebview.dylib",
        "../build/libwebview.dylib",
        ["-x", "-S"],
      );
      break;
    default:
      console.error(`unsupported platform ${platform}`);
      process.exit(1);
  }
} catch (err) {
  const code = (err as { exitCode?: number }).exitCode;
  console.error(String((err as { stderr?: unknown }).stderr ?? err));
  process.exit(typeof code === "number" && code !== 0 ? code : 1);
}

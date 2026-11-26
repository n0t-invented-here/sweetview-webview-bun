import { $ } from "bun";

// Every step must succeed: a failed configure, build, copy or strip ends the
// script with that step's exit code, so `just build` never goes on to accept
// a library left in build/ by an earlier run.
$.throws(true);

const { arch, platform } = process;

const configureFlags = [
  "-DWEBVIEW_ENABLE_CHECKS=false",
  "-DWEBVIEW_BUILD_AMALGAMATION=false",
  "-DWEBVIEW_BUILD_EXAMPLES=false",
  "-DWEBVIEW_BUILD_STATIC_LIBRARY=false",
  "-DWEBVIEW_BUILD_TESTS=false",
];

async function build(toolchain: string, extra: string[], built: string, shipped: string, strip: string[]) {
  await $`cmake -G ${"Ninja Multi-Config"} -B build -S . -DCMAKE_TOOLCHAIN_FILE=${toolchain} ${extra} ${configureFlags}`.cwd("webview");
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
        "cmake/toolchains/host-llvm.cmake",
        ["-DWEBVIEW_WEBKITGTK_API=6.0"],
        "build/core/Release/libwebview.so",
        `../build/libwebview-${arch}.so`,
        [],
      );
      break;
    case "darwin":
      await build(
        "cmake/toolchains/universal-macos-llvm.cmake",
        [],
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

// vitest.win.config.ts — run the unit suite with Windows path semantics, on any OS.
//
// `npm run test:winpaths`
//
// Aliasing node:path to its win32 flavour makes join/resolve/relative/sep behave
// as they do on Windows, which is where every path bug this project has hit
// actually lives. It turns a 3-minute CI round trip into a 2-second one.
//
// What it does NOT simulate: the real filesystem (case-insensitivity, drive
// letters, UNC paths, permissions) or process spawning. It is a fast first
// filter, not a replacement for the windows-latest job in CI — that one stays
// the source of truth.
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: [{ find: /^node:path$/, replacement: "node:path/win32" }] },
  test: {
    include: ["src/**/*.test.ts"],
    // integration tests drive REAL processes and a real fs, so win32 path
    // semantics on a POSIX machine would be meaningless there
    exclude: ["src/**/*.integration.test.ts"],
  },
});

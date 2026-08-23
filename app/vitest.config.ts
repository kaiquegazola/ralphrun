import { defineConfig } from "vitest/config";

// The app's own suite. Two shapes live here:
//  - main-process units (src/bun/**), plain node, no DOM
//  - view units and screen renders (src/mainview/**), which need a document
// happy-dom covers both cheaply, so one environment keeps the config honest.
export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // .hutch is the projected Electrobun devkit — someone else's tests.
    exclude: ["node_modules/**", ".hutch/**", "build/**"],
  },
});

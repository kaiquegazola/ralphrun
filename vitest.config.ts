import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // the suite is the CORE's. app/ is the Electrobun desktop app: its
    // dependencies (and the Hutch devkit it projects into app/.hutch) ship
    // their own tests, which are not ours to run or to fail on.
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // bin shim + untestable Ink render glue (tsx files already outside the *.ts
      // glob; listed explicitly).
      exclude: [
        "src/index.ts",
        "src/tui/App.tsx",
        "src/tui/mount.ts",
        "src/tui/prd/PrdApp.tsx",
        "src/tui/wizard/WizardApp.tsx",
        "src/tui/wizard/mount.ts",
      ],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});

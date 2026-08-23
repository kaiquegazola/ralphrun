import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "ralphrun",
    identifier: "dev.ralphrun.mission-control",
    version: "0.1.0",
  },
  build: {
    mainProcess: "bun",
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/mainview/index.tsx",
        format: "esm",
      },
    },
    copy: {
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/theme.css": "views/mainview/theme.css",
      // the run child is bundled by `bun run build:child` before every build —
      // the main process spawns it per run so each run gets its own module
      // registry (the core's event bus and i18n locale are module globals).
      "resources/run-child.js": "resources/run-child.js",
    },
  },
} satisfies ElectrobunConfig;

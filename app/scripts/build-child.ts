// build-child.ts — bundle the per-run child process.
//
// One thing here is not plain `bun build`: Ink statically imports
// `react-devtools-core`, an OPTIONAL peer that nobody installs, from a module
// it only ever loads when DEV=true. Left external the bundle keeps a top-level
// import of a package that is not there and the child dies before the first
// task; bundled it cannot be resolved at all. Stubbing it is the truthful
// third option — the code path that would use it never runs headless.

import { plugin } from "bun";

const stubMissingDevtools = {
  name: "stub-react-devtools",
  setup(build: Bun.PluginBuilder): void {
    build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({
      path: args.path,
      namespace: "devtools-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "devtools-stub" }, () => ({
      // Ink calls `devtools.connectToDevTools()`; the object shape is all the
      // stub owes it, since the branch that reaches it is DEV-only.
      contents: "export default { connectToDevTools() {} };",
      loader: "js" as const,
    }));
  },
} satisfies Bun.BunPlugin;

void plugin;

const result = await Bun.build({
  entrypoints: ["src/bun/run-child.ts"],
  target: "bun",
  outdir: "resources",
  naming: "run-child.js",
  plugins: [stubMissingDevtools],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const [out] = result.outputs;
console.log(`run-child.js  ${(out.size / 1024 / 1024).toFixed(2)} MB`);

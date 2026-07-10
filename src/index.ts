#!/usr/bin/env node
// ralphrun — installable entry. `npx ralphrun`, `ralphrun run`, etc.

import { program } from "./cli.js";

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
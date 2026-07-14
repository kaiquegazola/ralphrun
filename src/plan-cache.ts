// plan-cache.ts — deterministic provenance for persisted CROSS advisor plans.

import { createHash } from "node:crypto";
import type { AgentSpec } from "./config.js";
import type { PRD, Task } from "./prd.js";
import { advisorPrompt } from "./prompts.js";

export function advisorPlanKey(task: Task, prd: PRD, advisor: AgentSpec, standards: string): string {
  const promptHash = createHash("sha256").update(advisorPrompt(task, prd, standards)).digest("hex");
  return `${advisor.cli}:${advisor.model}:${promptHash}`;
}

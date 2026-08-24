// resources.ts — external-resource concurrency contract and conservative probe.
// Worktrees isolate files, not databases, caches, ports, or containers. The
// planner declares the contract; this module is the runtime backstop when a
// verify command makes the risk visible even if the declaration is incomplete.

import type { ResourceAccess, Task, TaskResources } from "./prd.js";

export interface ResourceAssessment {
  parallel: "safe" | "exclusive";
  resources: TaskResources;
  reasons: string[];
}

const DATABASE_RESET = /\b(?:db:reset|db:push|drop\s+(?:database|schema|table)|truncate|reset\s+database|docker\s+(?:compose|compose\.yml).*down)\b/i;
const DATABASE_WRITE = /\b(?:db:migrate|migrate|migration|prisma|drizzle|typeorm|sequelize|knex|postgres(?:ql)?|mysql|sqlite|mongodb|DATABASE_URL)\b/i;
const CACHE_WRITE = /\b(?:redis|valkey|ioredis|bullmq|flushdb|flushall|CACHE_URL|REDIS_URL)\b/i;
const FIXED_PORT = /--port\s*=?\s*(\d+)|(?<!:\/\/)(?:localhost|127\.0\.0\.1):(\d+)|listen\s*\(\s*(\d+)/gi;
const SHARED_SERVICE = /\b(?:docker\s+compose|docker-compose|compose\.ya?ml|kubectl|kind\b|minikube)\b/i;

const accessRank: Record<ResourceAccess, number> = { isolated: 0, read: 1, write: 2, reset: 3 };

function stronger(a: ResourceAccess | undefined, b: ResourceAccess): ResourceAccess {
  // An explicit per-task namespace is stronger evidence than a generic token
  // such as DATABASE_URL, migration, or redis in the verify command. The probe
  // must not turn a correctly isolated resource back into a shared one.
  if (a === "isolated") return a;
  return !a || accessRank[b] > accessRank[a] ? b : a;
}

function copyResources(resources?: TaskResources): TaskResources {
  return resources
    ? {
        ...(resources.database ? { database: resources.database } : {}),
        ...(resources.cache ? { cache: resources.cache } : {}),
        ...(resources.ports ? { ports: [...resources.ports] } : {}),
        ...(resources.services ? { services: [...resources.services] } : {}),
      }
    : {};
}

/**
 * Assess one task before dispatch. A missing parallel contract is deliberately
 * exclusive: old PRDs remain safe, while new planner output can opt into waves.
 */
export function assessTaskResources(task: Task): ResourceAssessment {
  const text = task.verify ?? "";
  const resources = copyResources(task.resources);
  const reasons: string[] = [];
  let inferredDatabaseRisk = false;
  let inferredCacheRisk = false;
  let inferredServiceRisk = false;

  if (!task.parallel) reasons.push("no parallel contract");
  if (task.parallel === "exclusive") reasons.push("planner marked task exclusive");

  if (DATABASE_RESET.test(text)) {
    resources.database = stronger(resources.database, "reset");
    inferredDatabaseRisk = !task.resources?.database || task.resources.database === "read";
    reasons.push("verify mentions database reset/destructive setup");
  } else if (DATABASE_WRITE.test(text)) {
    resources.database = stronger(resources.database, "write");
    inferredDatabaseRisk = !task.resources?.database || task.resources.database === "read";
    reasons.push("verify mentions a database or migration");
  }
  if (CACHE_WRITE.test(text)) {
    resources.cache = stronger(resources.cache, "write");
    inferredCacheRisk = !task.resources?.cache || task.resources.cache === "read";
    reasons.push("verify mentions a shared cache/queue");
  }
  const detectedPorts = [...text.matchAll(FIXED_PORT)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (detectedPorts.length) {
    const ports = new Set(resources.ports ?? []);
    for (const port of detectedPorts) ports.add(port);
    resources.ports = [...ports];
    reasons.push("verify mentions a fixed local port");
  }
  if (SHARED_SERVICE.test(text)) {
    if (!resources.services?.length) {
      resources.services = ["container-or-cluster"];
      inferredServiceRisk = true;
    }
    reasons.push("verify mentions a shared service manager");
  }

  const inferredRisk = inferredDatabaseRisk || inferredCacheRisk || inferredServiceRisk;
  const parallel = task.parallel === "safe" && !inferredRisk ? "safe" : "exclusive";
  if (task.parallel === "safe" && inferredRisk) {
    for (const key of ["database", "cache"] as const)
      if (resources[key] === "write" || resources[key] === "reset") reasons.push(`${key} is shared and mutable`);
    if (resources.ports?.length) reasons.push("fixed ports are shared");
    if (resources.services?.length) reasons.push("external services are shared");
    reasons.push("declared safe but resource probe found shared state");
  }
  return { parallel, resources, reasons };
}

function accessConflicts(a?: ResourceAccess, b?: ResourceAccess): boolean {
  if (!a || !b || a === "isolated" || b === "isolated") return false;
  return a !== "read" || b !== "read";
}

function listConflicts(a?: string[], b?: string[]): boolean {
  return !!a?.length && !!b?.length && (a.includes("*") || b.includes("*") || a.some((x) => b.includes(x)));
}

/** Return a human-readable reason when two tasks cannot share a wave. */
export function resourceConflict(a: Task, b: Task): string | undefined {
  const aa = assessTaskResources(a);
  const bb = assessTaskResources(b);
  if (aa.parallel !== "safe") return `${a.id}: ${aa.reasons.join(", ") || "exclusive task"}`;
  if (bb.parallel !== "safe") return `${b.id}: ${bb.reasons.join(", ") || "exclusive task"}`;
  if (accessConflicts(aa.resources.database, bb.resources.database)) return "both tasks share a mutable database";
  if (accessConflicts(aa.resources.cache, bb.resources.cache)) return "both tasks share a mutable cache or queue";
  if (listConflicts(aa.resources.ports, bb.resources.ports)) return "both tasks claim the same fixed port";
  if (listConflicts(aa.resources.services, bb.resources.services)) return "both tasks claim the same external service";
  return undefined;
}

export function taskCanRunInWave(task: Task): boolean {
  return assessTaskResources(task).parallel === "safe";
}

/** Environment contract for project-specific test/database isolation. */
export function taskRuntimeEnv(runId: string, taskId: string): NodeJS.ProcessEnv {
  const value = `${runId}-${taskId}`;
  return {
    RALPHRUN_RUN_ID: runId,
    RALPHRUN_TASK_ID: taskId,
    RALPHRUN_TEST_RUN_ID: value,
    TEST_RUN_ID: value,
    TEST_DB_SUFFIX: value,
  };
}

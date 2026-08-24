import { describe, expect, it } from "vitest";
import { assessTaskResources, resourceConflict, taskCanRunInWave, taskRuntimeEnv } from "./resources.js";
import type { Task } from "./prd.js";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "T1",
    title: "task",
    status: "todo",
    deps: [],
    retries: 0,
    description: "",
    acceptance: [],
    verify: "vitest run src/foo.test.ts",
    ...over,
  };
}

describe("assessTaskResources", () => {
  it("keeps legacy or undeclared tasks serial", () => {
    expect(assessTaskResources(task()).parallel).toBe("exclusive");
    expect(assessTaskResources(task()).reasons).toContain("no parallel contract");
  });

  it("allows an explicitly safe task with no shared-resource signal", () => {
    expect(taskCanRunInWave(task({ parallel: "safe" }))).toBe(true);
  });

  it("downgrades a falsely safe database migration", () => {
    const result = assessTaskResources(task({ parallel: "safe", verify: "npm run db:migrate && npm test" }));
    expect(result.parallel).toBe("exclusive");
    expect(result.resources.database).toBe("write");
  });

  it("recognizes destructive database and fixed-port checks", () => {
    const result = assessTaskResources(
      task({ parallel: "safe", verify: "npm run db:reset && npm run dev -- --port 4173" }),
    );
    expect(result.resources.database).toBe("reset");
    expect(result.resources.ports).toEqual(["4173"]);
    expect(result.parallel).toBe("exclusive");
  });

  it("keeps explicitly named disjoint ports and services eligible", () => {
    expect(taskCanRunInWave(task({ parallel: "safe", resources: { ports: ["4173"], services: ["api-a"] } }))).toBe(true);
  });

  it("does not overwrite explicitly isolated database or cache access", () => {
    const result = assessTaskResources(
      task({ parallel: "safe", verify: "DATABASE_URL=test npm run db:migrate && redis-cli ping", resources: { database: "isolated", cache: "isolated" } }),
    );
    expect(result.parallel).toBe("safe");
    expect(result.resources).toMatchObject({ database: "isolated", cache: "isolated" });
  });
});

describe("resourceConflict", () => {
  it("allows independent safe tasks", () => {
    expect(resourceConflict(task({ id: "A", parallel: "safe" }), task({ id: "B", parallel: "safe" }))).toBeUndefined();
  });

  it("serializes two tasks that declare a mutable database", () => {
    const a = task({ id: "A", parallel: "safe", resources: { database: "write" } });
    const b = task({ id: "B", parallel: "safe", resources: { database: "read" } });
    expect(taskCanRunInWave(a)).toBe(true);
    expect(resourceConflict(a, b)).toContain("database");
  });

  it("allows two isolated databases and two read-only databases", () => {
    expect(resourceConflict(task({ parallel: "safe", resources: { database: "isolated" } }), task({ id: "B", parallel: "safe", resources: { database: "isolated" } }))).toBeUndefined();
    expect(resourceConflict(task({ parallel: "safe", resources: { database: "read" } }), task({ id: "B", parallel: "safe", resources: { database: "read" } }))).toBeUndefined();
  });

  it("allows disjoint named resources and blocks the same name", () => {
    const a = task({ id: "A", parallel: "safe", resources: { ports: ["4173"], services: ["api-a"] } });
    const b = task({ id: "B", parallel: "safe", resources: { ports: ["4174"], services: ["api-b"] } });
    expect(resourceConflict(a, b)).toBeUndefined();
    expect(resourceConflict(a, { ...b, resources: { ports: ["4173"], services: ["api-b"] } })).toContain("port");
  });
});

describe("taskRuntimeEnv", () => {
  it("gives every wave task a stable run/task identity", () => {
    expect(taskRuntimeEnv("run-1", "T2")).toEqual({
      RALPHRUN_RUN_ID: "run-1",
      RALPHRUN_TASK_ID: "T2",
      RALPHRUN_TEST_RUN_ID: "run-1-T2",
      TEST_RUN_ID: "run-1-T2",
      TEST_DB_SUFFIX: "run-1-T2",
    });
  });
});

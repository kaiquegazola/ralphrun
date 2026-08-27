import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAIN_DIRECTORY, BRAIN_GLOBAL, BRAIN_INDEX, brainGlobalBlock, brainPromptBlock, syncBrain } from "./brain.js";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

describe("brain files", () => {
  it("syncs architecture notes to global.md and creates an index", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ralphrun-brain-"));
    workspaces.push(workspace);

    syncBrain(workspace, "global rule");

    expect(existsSync(join(workspace, BRAIN_DIRECTORY, BRAIN_GLOBAL))).toBe(true);
    expect(readFileSync(join(workspace, BRAIN_DIRECTORY, BRAIN_GLOBAL), "utf8")).toContain("global rule");
    expect(readFileSync(join(workspace, BRAIN_DIRECTORY, BRAIN_INDEX), "utf8")).toContain("global.md");
  });

  it("sends the index, not the large global file, to prompts", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ralphrun-brain-"));
    workspaces.push(workspace);
    syncBrain(workspace, "secret architecture detail");

    const indexPath = join(workspace, BRAIN_DIRECTORY, BRAIN_INDEX);
    writeFileSync(indexPath, "# Brain\n- desktop.md - Electrobun capture\n");

    const prompt = brainPromptBlock(workspace);
    expect(prompt).toContain(".ralphrun/brain/global.md");
    expect(prompt).toContain("desktop.md");
    expect(prompt).not.toContain("secret architecture detail");
  });

  it("copies indexed topic files into a task worktree", () => {
    const source = mkdtempSync(join(tmpdir(), "ralphrun-brain-source-"));
    const worktree = mkdtempSync(join(tmpdir(), "ralphrun-brain-worktree-"));
    workspaces.push(source, worktree);
    syncBrain(source, "global rule");
    writeFileSync(join(source, BRAIN_DIRECTORY, BRAIN_INDEX), "# Brain\n- desktop.md - Electrobun capture\n");
    writeFileSync(join(source, BRAIN_DIRECTORY, "desktop.md"), "desktop-only rule");

    expect(syncBrain(worktree, "global rule", source)).toBe(true);
    expect(readFileSync(join(worktree, BRAIN_DIRECTORY, BRAIN_INDEX), "utf8")).toContain("desktop.md");
    expect(readFileSync(join(worktree, BRAIN_DIRECTORY, "desktop.md"), "utf8")).toContain("desktop-only rule");
  });

  it("does not trust stale brain content after synchronization fails", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ralphrun-brain-"));
    workspaces.push(workspace);
    syncBrain(workspace, "old rule");
    mkdirSync(join(workspace, ".ralphrun"), { recursive: true });
    rmSync(join(workspace, ".ralphrun", "brain"), { recursive: true, force: true });
    writeFileSync(join(workspace, ".ralphrun", "brain"), "not a directory");

    expect(syncBrain(workspace, "new rule", workspace)).toBe(false);
    expect(brainPromptBlock(workspace)).toBe("");
    expect(brainGlobalBlock(workspace)).toBe("");
  });

  it("falls back cleanly when the brain is unavailable", () => {
    const workspace = mkdtempSync(join(tmpdir(), "ralphrun-brain-"));
    workspaces.push(workspace);

    expect(brainPromptBlock(workspace)).toBe("");
  });
});
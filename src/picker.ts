// picker.ts — fuzzy file picker estilo `@` do opencode / claude code.
// Glob recursivo -> autocomplete do Clack com filter custom fzf-style.
// Retorna o path absoluto escolhido, ou null em cancelamento.

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as p from "@clack/prompts";

const IGNORE = new Set(["node_modules", ".git", "dist", ".next", ".venv", "venv", "__pycache__", ".cache", ".turbo"]);

export interface PickFileOptions {
  cwd: string;
  message: string;
  pattern?: string; // glob (extensão parametrizável: "*.json")
  maxItems?: number;
  extraOptions?: Array<{ value: string; label: string; hint?: string }>;
}

export async function pickFile(opts: PickFileOptions): Promise<string | null> {
  const cwd = resolve(opts.cwd);
  const files = globJson(cwd, opts.pattern ?? "*.json", opts.maxItems ?? 200);

  const options: Array<{ value: string; label: string; hint?: string }> = files.map((f) => ({
    value: f.absolute,
    label: f.relative,
    hint: "json",
  }));
  if (opts.extraOptions) options.unshift(...opts.extraOptions);

  if (options.length === 0) {
    p.log.warn(`No "${opts.pattern ?? "*.json"}" files found under ${cwd}.`);
    return null;
  }

  const choice = await p.autocomplete({
    message: opts.message,
    options,
    placeholder: "type to fuzzy-filter…",
    maxItems: 12,
    filter: (search, option) => {
      if (!search.trim()) return true;
      const label = (option.label ?? String(option.value)).toLowerCase();
      return fzfMatch(search.trim().toLowerCase(), label) !== null;
    },
  });

  if (p.isCancel(choice)) {
    p.cancel("cancelled.");
    return null;
  }
  return String(choice);
}

interface Found {
  absolute: string;
  relative: string;
  dir?: boolean; // directories get a trailing "/" label and sort first (like Claude Code's @)
}

function globJson(root: string, pattern: string | null, max: number): Found[] {
  const ext = pattern && pattern.startsWith("*.") ? pattern.slice(1) : null; // ".json"; "*"/null -> all files
  const out: Found[] = [];
  walk(root, root, ext, max, out, new Set());
  return out;
}

// readAttachment — lê o arquivo (utf8), corta em 12000 chars. Nunca lança.
const ATTACH_CAP = 12000;
export function readAttachment(path: string): { path: string; content: string; truncated: boolean; ok: boolean } {
  try {
    const raw = readFileSync(path, "utf8");
    const truncated = raw.length > ATTACH_CAP;
    return { path, content: truncated ? raw.slice(0, ATTACH_CAP) : raw, truncated, ok: true };
  } catch {
    // ok:false lets the caller tell a missing/unreadable file apart from an empty one
    return { path, content: "", truncated: false, ok: false };
  }
}

// searchFiles — picker inline do '@' estilo Claude Code. Com '/' (ou absoluto), o
// fragmento enraíza no diretório e lista os FILHOS IMEDIATOS (pastas primeiro, com
// "/"); o basename (se não for dir) vira needle sobre esses filhos. Sem '/', fuzzy
// recursivo sobre cwd (só arquivos). Rankeia por fzf.
export function searchFiles(fragment: string, cwd: string, max = 500): Found[] {
  // expand a leading ~ to the home dir — the shell does this, Node's fs does not,
  // so "@~/Desktop" would otherwise resolve to a literal "./~/Desktop" and find nothing.
  if (fragment === "~" || fragment.startsWith("~/")) fragment = homedir() + fragment.slice(1);
  let root: string;
  let needle: string;
  let rooted = false;
  if (fragment.includes("/") || isAbsolute(fragment)) {
    rooted = true;
    const abs = isAbsolute(fragment) ? resolve(fragment) : resolve(cwd, fragment);
    if (fragment.endsWith("/") || isDir(abs)) {
      // "@~/Desktop" — the fragment names a directory: list its contents,
      // don't treat "Desktop" as a needle over the parent (which walks all of ~).
      root = abs;
      needle = "";
    } else {
      root = dirname(abs);
      needle = basename(abs);
    }
  } else {
    root = resolve(cwd);
    needle = fragment;
  }
  let found: Found[];
  if (rooted) {
    // immediate children only — fast + predictable on huge dirs; descend by selecting a dir
    found = listChildren(root);
  } else {
    found = [];
    walk(root, root, null, 1000, found, new Set());
  }
  const n = needle.toLowerCase();
  return found
    .map((f) => ({ f, score: fzfMatch(n, f.relative.toLowerCase())?.score ?? null }))
    .filter((x): x is { f: Found; score: number } => x.score !== null)
    // dirs first, then fzf score, then alphabetical
    .sort(
      (a, b) =>
        Number(!!b.f.dir) - Number(!!a.f.dir) || b.score - a.score || a.f.relative.localeCompare(b.f.relative),
    )
    .slice(0, max)
    .map((x) => x.f);
}

function listChildren(root: string): Found[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Found[] = [];
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    if (e.isDirectory()) out.push({ absolute: join(root, e.name), relative: e.name + "/", dir: true });
    else if (e.isFile()) out.push({ absolute: join(root, e.name), relative: e.name });
  }
  return out;
}

function walk(root: string, dir: string, ext: string | null, max: number, out: Found[], seen: Set<string>): void {
  if (out.length >= max) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name.startsWith(".") && IGNORE.has(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE.has(e.name)) continue;
      const real = realpathSafe(full);
      if (seen.has(real)) continue;
      seen.add(real);
      walk(root, full, ext, max, out, seen);
    } else if (e.isFile()) {
      if (ext && !e.name.endsWith(ext)) continue;
      out.push({ absolute: full, relative: relative(root, full).split(sep).join("/") });
    }
  }
}

function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// fzf-style scoring: subsequence match + score favoring consecutive matches,
// prefix, and matches at camelCase boundaries. Returns null se não combinar.
interface Scored {
  score: number;
}

export function fzfMatch(needle: string, haystack: string): Scored | null {
  if (!needle) return { score: 0 };
  let score = 0;
  let consec = 0;
  let ni = 0;
  let lastMatchIdx = -1;
  for (let hi = 0; hi < haystack.length && ni < needle.length; hi++) {
    const h = haystack[hi];
    const n = needle[ni];
    if (h === n) {
      let bonus = 1;
      if (hi === 0 || /[\s/_.-]/.test(haystack[hi - 1])) bonus += 8; // boundary
      if (hi === lastMatchIdx + 1) {
        consec++;
        bonus += 5 * consec; // consecutive
      } else {
        consec = 0;
      }
      if (hi === ni && hi === 0) bonus += 10; // exact prefix start
      score += bonus;
      lastMatchIdx = hi;
      ni++;
    } else {
      consec = 0;
    }
  }
  if (ni < needle.length) return null; // não completou
  // matches starting earlier > later; tighter matches > scattered
  score += Math.max(0, 64 - lastMatchIdx);
  return { score };
}
// markdown.test.ts — mdToLines: estilos, fences, wrap exato por largura.
import { describe, it, expect } from "vitest";
import { mdToLines, type Span } from "./markdown.js";

const flat = (lines: Span[][]): string[] => lines.map((l) => l.map((s) => s.text).join(""));

describe("mdToLines", () => {
  it("plain text passes through as one line", () => {
    expect(mdToLines("hello", 80)).toEqual([[{ text: "hello", style: "plain" }]]);
  });

  it("empty input yields a single empty plain line", () => {
    expect(mdToLines("", 80)).toEqual([[{ text: "", style: "plain" }]]);
  });

  it("headings (#, ##, ###) become heading spans without the marker", () => {
    const lines = mdToLines("# Title\n## Sub\n### Deep", 80);
    expect(lines.map((l) => l[0])).toEqual([
      { text: "Title", style: "heading" },
      { text: "Sub", style: "heading" },
      { text: "Deep", style: "heading" },
    ]);
  });

  it("bullets get a • marker span + inline-parsed rest", () => {
    const [line] = mdToLines("- item with **bold**", 80);
    expect(line[0]).toEqual({ text: "• ", style: "bullet" });
    expect(line).toContainEqual({ text: "bold", style: "bold" });
    const [star] = mdToLines("* starred", 80);
    expect(star[0].style).toBe("bullet");
  });

  it("inline **bold** and `code` split into styled spans", () => {
    const [line] = mdToLines("a **b** c `d` e", 80);
    expect(line).toEqual([
      { text: "a ", style: "plain" },
      { text: "b", style: "bold" },
      { text: " c ", style: "plain" },
      { text: "d", style: "code" },
      { text: " e", style: "plain" },
    ]);
  });

  it("fenced blocks render whole lines as code and hide the fence markers", () => {
    const lines = mdToLines("before\n```\nconst x = 1\n```\nafter", 80);
    expect(flat(lines)).toEqual(["before", "const x = 1", "after"]);
    expect(lines[1][0].style).toBe("code");
  });

  it("fence with language tag still toggles", () => {
    const lines = mdToLines("```json\n{}\n```", 80);
    expect(flat(lines)).toEqual(["{}"]);
    expect(lines[0][0].style).toBe("code");
  });

  it("hard-wraps to width preserving span styles across the cut", () => {
    const lines = mdToLines("aaaa**BBBB**cccc", 6);
    expect(flat(lines)).toEqual(["aaaaBB", "BBcccc"]);
    expect(lines[0][1]).toEqual({ text: "BB", style: "bold" });
    expect(lines[1][0]).toEqual({ text: "BB", style: "bold" });
  });

  it("width floor of 1 avoids infinite loops on width 0", () => {
    const lines = mdToLines("ab", 0);
    expect(flat(lines)).toEqual(["a", "b"]);
  });

  it("a line ending exactly at width does not spill an empty extra line", () => {
    expect(flat(mdToLines("abcdef", 6))).toEqual(["abcdef"]);
  });

  it("input that is ONLY a fence marker yields the empty fallback line", () => {
    expect(mdToLines("```", 80)).toEqual([[{ text: "", style: "plain" }]]);
  });

  it("blank line inside text is preserved as an empty plain line", () => {
    expect(flat(mdToLines("a\n\nb", 80))).toEqual(["a", "", "b"]);
  });

  it("bold-only line parses without leading plain span", () => {
    const [line] = mdToLines("**all bold**", 80);
    expect(line).toEqual([{ text: "all bold", style: "bold" }]);
  });
});

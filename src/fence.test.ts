// fence.test.ts — fenced-block extraction against REAL failure shapes
import { describe, expect, it } from "vitest";

import { fencedBlocks, lastJsonObject } from "./fence.js";

const join = (lines: string[]): string => lines.join("\n");

describe("fencedBlocks", () => {
  it("pairs a tagged opener with its bare closer", () => {
    const blocks = fencedBlocks(join(["prose", "```json", '{"a":1}', "```", "tail"]));
    expect(blocks).toEqual(['{"a":1}']);
  });

  it("keeps an unterminated tail — a model that died mid-fence still said something", () => {
    const blocks = fencedBlocks(join(["```json", '{"a":1}']));
    expect(blocks).toEqual(['{"a":1}']);
  });

  // the shape that once discarded a valid 33-task PRD: four tagged openers, one
  // bare closer at the very end. The stray closer must NOT open a new block.
  it("multiple draft openers and one final closer leave the real payload intact", () => {
    const blocks = fencedBlocks(
      join([
        "summary line",
        "```json",
        "{draft one",
        "```json",
        "{draft two",
        "```json",
        "{draft three",
        "```json",
        '{"final":true}',
        "```",
      ]),
    );
    expect(blocks).toEqual(["{draft one", "{draft two", "{draft three", '{"final":true}']);
  });

  it("a bare ``` with nothing open is ignored, not treated as an opener", () => {
    const blocks = fencedBlocks(join(["text", "```", "more text", "```json", '{"a":1}', "```"]));
    expect(blocks).toEqual(['{"a":1}']);
  });
});

describe("lastJsonObject", () => {
  it("returns the LAST parseable object, skipping earlier invalid drafts", () => {
    const text = join(["```json", "{broken", "```", "note", "```json", '{"tasks":[]}', "```"]);
    expect(lastJsonObject(text)).toEqual({ tasks: [] });
  });

  it("null when nothing fenced parses as an object", () => {
    expect(lastJsonObject(join(["```json", "[1,2]", "```"]))).toBeNull();
    expect(lastJsonObject("no fences at all")).toBeNull();
  });

  it("slices to the outer braces even with prose inside the block", () => {
    const text = join(["```json", "here you go:", '{"ok":true}', "```"]);
    expect(lastJsonObject(text)).toEqual({ ok: true });
  });
});

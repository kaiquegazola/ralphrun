// fullscreen.test.ts — verifies the alt-screen escape sequences and the
// default process.stdout path.

import { describe, it, expect, vi, afterEach } from "vitest";
import { enterAltScreen, exitAltScreen, setTitle } from "./fullscreen.js";

afterEach(() => vi.restoreAllMocks());

describe("fullscreen", () => {
  it("enterAltScreen writes alt-buffer-on + cursor-hide + alternate-scroll-on", () => {
    const writes: string[] = [];
    enterAltScreen({ write: (s) => writes.push(s) });
    expect(writes).toEqual(["\x1b[?1049h\x1b[?25l\x1b[?1007h"]);
  });

  it("exitAltScreen writes alternate-scroll-off + alt-buffer-off + cursor-show", () => {
    const writes: string[] = [];
    exitAltScreen({ write: (s) => writes.push(s) });
    expect(writes).toEqual(["\x1b[?1007l\x1b[?1049l\x1b[?25h"]);
  });

  it("defaults to process.stdout", () => {
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    enterAltScreen();
    exitAltScreen();
    expect(spy).toHaveBeenNthCalledWith(1, "\x1b[?1049h\x1b[?25l\x1b[?1007h");
    expect(spy).toHaveBeenNthCalledWith(2, "\x1b[?1007l\x1b[?1049l\x1b[?25h");
  });

  it("setTitle writes the OSC 0 window-title sequence", () => {
    const writes: string[] = [];
    setTitle("MyProject · 3/8", { write: (s) => writes.push(s) });
    expect(writes).toEqual(["\x1b]0;MyProject · 3/8\x07"]);
  });
});

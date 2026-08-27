import { describe, expect, it } from "vitest";
import { hostMismatch, isRequiredHost } from "./host.js";

describe("host requirements", () => {
  it("accepts an omitted requirement and a matching host", () => {
    expect(hostMismatch(undefined, "win32")).toBeNull();
    expect(hostMismatch("win32", "win32")).toBeNull();
    expect(hostMismatch(["darwin", "win32"], "win32")).toBeNull();
  });

  it("reports the required and current hosts on mismatch", () => {
    expect(hostMismatch("darwin", "win32")).toBe("required_host=darwin; current_host=win32");
    expect(hostMismatch(["darwin", "linux"], "win32")).toContain("required_host=darwin, linux");
  });

  it("validates platform strings and non-empty platform lists", () => {
    expect(isRequiredHost("darwin")).toBe(true);
    expect(isRequiredHost(["linux", "win32"])).toBe(true);
    expect(isRequiredHost([])).toBe(false);
    expect(isRequiredHost(["linux", "not-a-platform"])).toBe(false);
    expect(isRequiredHost("macos")).toBe(false);
  });
});

// ui.test.tsx — the formatters and the four controls every screen repeats.
// ui.tsx is pure presentation and never touches ../api.ts, so there is nothing
// to mock here: the whole point of the module is that it renders standalone.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

import { Avatar, ProgressBar, Seg, Toggle, ago, clock, elapsed } from "./ui.tsx";

const T0 = 1_700_000_000_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("elapsed", () => {
  it("stays on mm:ss under an hour and zero-pads both halves", () => {
    expect(elapsed(T0, T0 + 7_000)).toBe("00:07");
    expect(elapsed(T0, T0 + 65_000)).toBe("01:05");
    expect(elapsed(T0, T0 + 59 * 60_000 + 59_000)).toBe("59:59");
  });

  it("grows an hours field once it passes 60 minutes, unpadded", () => {
    // h:mm:ss, not hh:mm:ss — a run bar reading "1:00:00" is the design.
    expect(elapsed(T0, T0 + 3_600_000)).toBe("1:00:00");
    expect(elapsed(T0, T0 + 3_600_000 + 125_000)).toBe("1:02:05");
    expect(elapsed(T0, T0 + 12 * 3_600_000)).toBe("12:00:00");
  });

  it("floors at zero so a clock skew never shows a negative run time", () => {
    expect(elapsed(T0, T0 - 90_000)).toBe("00:00");
    expect(elapsed(T0, T0)).toBe("00:00");
  });

  it("defaults the end to now, which is what every live counter passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 30_000);
    expect(elapsed(T0)).toBe("00:30");
  });
});

describe("ago", () => {
  it("reads the whole ladder off the same fixed now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    expect(ago(T0 - 30_000)).toBe("agora"); // under a minute has no number
    expect(ago(T0 - 60_000)).toBe("há 1 min");
    expect(ago(T0 - 59 * 60_000)).toBe("há 59 min");
    expect(ago(T0 - 60 * 60_000)).toBe("há 1h");
    expect(ago(T0 - 23 * 3_600_000)).toBe("há 23h");
    expect(ago(T0 - 24 * 3_600_000)).toBe("há 1d");
    expect(ago(T0 - 10 * 24 * 3_600_000)).toBe("há 10d");
  });

  it("says 'agora' for a timestamp in the future instead of a negative count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    expect(ago(T0 + 5_000)).toBe("agora");
  });
});

describe("clock", () => {
  it("zero-pads both fields so the column never jitters", () => {
    const at = new Date(2024, 0, 2, 9, 5).getTime();
    expect(clock(at)).toBe("09:05");
    expect(clock(new Date(2024, 0, 2, 0, 0).getTime())).toBe("00:00");
    expect(clock(new Date(2024, 0, 2, 23, 59).getTime())).toBe("23:59");
  });
});

// The bar is three sibling spans; widths are the only thing worth asserting.
const segments = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".bar > span")].map((s) => s.style.width);

describe("ProgressBar", () => {
  it("sizes each segment as its share of the total, not of the sum", () => {
    const { container } = render(<ProgressBar done={5} doing={2} blocked={1} total={10} />);
    // the missing 20% is todo — deliberately unpainted, so the three add to 80%.
    expect(segments(container)).toEqual(["50%", "20%", "10%"]);
  });

  it("collapses to zero widths on an empty backlog instead of NaN%", () => {
    // total=0 happens on a PRD with no tasks yet; a NaN width kills the layout.
    const { container } = render(<ProgressBar done={0} doing={0} blocked={0} total={0} />);
    expect(segments(container)).toEqual(["0%", "0%", "0%"]);
    expect(container.innerHTML).not.toContain("NaN");
  });

  it("pulses the doing segment only while something is actually running", () => {
    const idle = render(<ProgressBar done={3} doing={0} blocked={0} total={3} />);
    expect(idle.container.querySelector(".bar .pulse")).toBeNull();
    const live = render(<ProgressBar done={1} doing={1} blocked={0} total={4} />);
    expect(live.container.querySelector(".bar .pulse")).toBeTruthy();
  });
});

describe("Seg", () => {
  it("marks exactly one option and reports the option's value, not its label", () => {
    const onChange = vi.fn();
    const { container } = render(
      <Seg
        value={2}
        options={[
          { value: 1, label: "um" },
          { value: 2, label: "dois" },
          { value: 4, label: "quatro" },
        ]}
        onChange={onChange}
      />,
    );
    const on = container.querySelectorAll(".seg button.on");
    expect(on.length).toBe(1);
    expect(on[0].textContent).toBe("dois");

    screen.getByText("quatro").click();
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it("falls back to the value as the label when none is given", () => {
    render(<Seg value="a" options={[{ value: "a" }, { value: "b" }]} onChange={vi.fn()} />);
    expect(screen.getByText("b")).toBeTruthy();
  });
});

describe("Toggle", () => {
  it("reports the value it is flipping TO, so the parent can store it directly", () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<Toggle on={false} onChange={onChange} />);
    const btn = container.querySelector("button")!;

    expect(btn.className).not.toContain("on");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(onChange).toHaveBeenCalledWith(true);

    // controlled: the class only follows once the parent hands the prop back.
    rerender(<Toggle on onChange={onChange} />);
    expect(btn.className).toContain("on");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    btn.click();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe("Avatar", () => {
  it("shows the designed initials for a known cli and titles it with the cli", () => {
    const { container } = render(<Avatar cli="claude" />);
    const el = container.querySelector(".avatar")!;
    expect(el.textContent).toBe("cl");
    expect(el.getAttribute("title")).toBe("claude");
  });

  it("falls back to the first two letters for a cli the registry never heard of", () => {
    render(<Avatar cli="zephyr" />);
    expect(screen.getByTitle("zephyr").textContent).toBe("ze");
  });

  it("scales the box off the size prop", () => {
    const { container } = render(<Avatar cli="codex" size={40} />);
    const el = container.querySelector<HTMLElement>(".avatar")!;
    expect(el.textContent).toBe("cx");
    expect(el.style.width).toBe("40px");
    expect(el.style.borderRadius).toBe("10px");
  });
});

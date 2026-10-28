import { describe, expect, test } from "bun:test";
import {
  buildChartSvg,
  formatTimeTick,
  niceYScale,
  renderPriceChart,
  textWidth,
  timeTicks,
  wrapText,
} from "./chart.js";

const HOUR = 3600;
const DAY = 24 * HOUR;
// 2026-10-28T00:00:00Z
const MIDNIGHT = Date.UTC(2026, 9, 28) / 1000;

function series(
  n: number,
  from: number,
  step: number,
  p = (i: number) => 0.4 + (i % 7) / 100,
) {
  return Array.from({ length: n }, (_, i) => ({ t: from + i * step, p: p(i) }));
}

describe("niceYScale", () => {
  test.each([
    [0.395, 0.525],
    [0.927, 0.96],
    [0.004, 0.376],
    [0.5, 0.5],
    [0.98, 0.999],
    [0, 1],
  ])("domain covers [%p, %p] with evenly spaced round ticks", (min, max) => {
    const { lo, hi, ticks } = niceYScale(min, max);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(lo).toBeLessThanOrEqual(min);
    expect(hi).toBeGreaterThanOrEqual(max);
    // Ticks sit exactly on the domain edges, so the grid spans the plot.
    expect(ticks[0]).toBeCloseTo(lo, 9);
    expect(ticks[ticks.length - 1]).toBeCloseTo(hi, 9);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    expect(ticks.length).toBeLessThanOrEqual(8);
    const step = (ticks[1] ?? 0) - (ticks[0] ?? 0);
    for (let i = 1; i < ticks.length; i++) {
      expect((ticks[i] ?? 0) - (ticks[i - 1] ?? 0)).toBeCloseTo(step, 9);
    }
  });

  test("labels get decimals only when the step needs them", () => {
    expect(niceYScale(0.2, 0.8).decimals).toBe(0);
    expect(niceYScale(0.5, 0.5).decimals).toBe(1);
  });
});

describe("timeTicks", () => {
  test("a 6-hour range ticks on the hour", () => {
    const { ticks, step } = timeTicks(
      MIDNIGHT + 5.4 * HOUR,
      MIDNIGHT + 11.5 * HOUR,
      6,
    );
    expect(step).toBe(HOUR);
    expect(ticks.map((t) => formatTimeTick(t, step))).toEqual([
      "06:00",
      "07:00",
      "08:00",
      "09:00",
      "10:00",
      "11:00",
    ]);
  });

  test("an intraday range crossing midnight labels midnight with the date", () => {
    const { ticks, step } = timeTicks(
      MIDNIGHT - 8 * HOUR,
      MIDNIGHT + 10 * HOUR,
      6,
    );
    const labels = ticks.map((t) => formatTimeTick(t, step));
    expect(labels).toContain("Oct 28");
    expect(labels.some((l) => /^\d\d:00$/.test(l))).toBe(true);
  });

  test("a week ticks on days", () => {
    const { ticks, step } = timeTicks(MIDNIGHT - 7 * DAY, MIDNIGHT, 6);
    expect(step).toBe(2 * DAY);
    for (const t of ticks) expect(t % DAY).toBe(0);
    expect(formatTimeTick(MIDNIGHT, step)).toBe("Oct 28");
  });

  test("long ranges tick on the 1st of the month, with the year at January", () => {
    const from = Date.UTC(2025, 10, 15) / 1000;
    const { ticks, step } = timeTicks(from, MIDNIGHT, 6);
    expect(ticks.length).toBeLessThanOrEqual(6);
    for (const t of ticks) expect(new Date(t * 1000).getUTCDate()).toBe(1);
    const labels = ticks.map((t) => formatTimeTick(t, step));
    expect(labels).toContain("2026");
  });

  test("never exceeds the requested count, at any span", () => {
    for (const span of [600, HOUR, DAY, 9 * DAY, 60 * DAY, 3 * 365 * DAY]) {
      const { ticks } = timeTicks(MIDNIGHT - span, MIDNIGHT, 6);
      expect(ticks.length).toBeLessThanOrEqual(6);
      for (const t of ticks) {
        expect(t).toBeGreaterThanOrEqual(MIDNIGHT - span);
        expect(t).toBeLessThanOrEqual(MIDNIGHT);
      }
    }
  });
});

describe("text fitting", () => {
  test("wider text measures wider", () => {
    expect(textWidth("WWW", 12, false)).toBeGreaterThan(
      textWidth("iii", 12, false),
    );
    expect(textWidth("abc", 12, true)).toBeGreaterThan(
      textWidth("abc", 12, false),
    );
  });

  test("wraps a long title into two lines that fit, ellipsizing the rest", () => {
    const title =
      "Will the Tampa Bay Rays win the 2026 World Series after a remarkable late-season comeback?";
    const lines = wrapText(title, 300, 17, true, 2);
    expect(lines).toHaveLength(2);
    for (const line of lines)
      expect(textWidth(line, 17, true)).toBeLessThanOrEqual(300);
    expect(lines[1]?.endsWith("…")).toBe(true);
  });

  test("short titles stay on one line, untouched", () => {
    expect(wrapText("Fed decision", 300, 17, true, 2)).toEqual([
      "Fed decision",
    ]);
  });

  test("a single overlong word is cut to fit", () => {
    const [line] = wrapText("x".repeat(200), 100, 17, true, 2);
    expect(textWidth(line ?? "", 17, true)).toBeLessThanOrEqual(100);
  });
});

describe("buildChartSvg", () => {
  test("escapes the title", () => {
    const svg = buildChartSvg(
      series(10, MIDNIGHT, HOUR),
      { title: `A <b> & "c"` },
      null,
    );
    expect(svg).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).not.toContain("<b>");
  });

  test("shows direction with a glyph, not just color", () => {
    const up = buildChartSvg(
      series(2, MIDNIGHT, HOUR, (i) => 0.3 + i * 0.1),
      { direction: "up" },
      null,
    );
    const down = buildChartSvg(
      series(2, MIDNIGHT, HOUR, (i) => 0.5 - i * 0.1),
      { direction: "down" },
      null,
    );
    expect(up).toContain("▲ 10.0 pts");
    expect(down).toContain("▼ 10.0 pts");
  });
});

describe("renderPriceChart", () => {
  test("needs at least two points", async () => {
    expect(await renderPriceChart([{ t: MIDNIGHT, p: 0.5 }])).toBeNull();
  });

  test("renders a PNG at 1.5x the logical size, cached for identical input", async () => {
    const points = series(100, MIDNIGHT, 5 * 60);
    const png = await renderPriceChart(points, {
      title: "Render test",
      direction: "up",
    });
    if (!png) throw new Error("no png");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200); // IHDR width
    expect(png.readUInt32BE(20)).toBe(630); // IHDR height
    expect(
      await renderPriceChart(points, { title: "Render test", direction: "up" }),
    ).toBe(png);
  });
});

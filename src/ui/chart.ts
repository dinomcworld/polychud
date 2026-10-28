import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import type { PricePoint } from "../services/polymarket.js";
import { logger } from "../utils/logger.js";

// Resvg has no fonts of its own. `loadSystemFonts: true` works in some
// environments but is unreliable across Linux distros / containers, so we
// also point at known TTF locations directly. The first matching pair (regular
// + bold) is used; if none match we fall back to system fonts.
const FONT_CANDIDATES: Array<{ regular: string; bold: string }> = [
  {
    regular: "/usr/share/fonts/TTF/DejaVuSans.ttf",
    bold: "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  },
  {
    regular: "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    bold: "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
  },
  {
    regular: "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    bold: "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  },
  {
    regular: "/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
    bold: "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf",
  },
];

const RESOLVED_FONTS: string[] = (() => {
  for (const { regular, bold } of FONT_CANDIDATES) {
    if (existsSync(regular)) {
      const files = [regular];
      if (existsSync(bold)) files.push(bold);
      logger.debug(`chart: using font files ${files.join(", ")}`);
      return files;
    }
  }
  logger.warn(
    "chart: no bundled font path matched; falling back to system fonts only",
  );
  return [];
})();

export type ChartDirection = "up" | "down" | "flat";

export interface ChartOptions {
  /** Logical size in px; the PNG is `scale` times larger. */
  width?: number;
  height?: number;
  /** Pixel density of the PNG. 1.5 stays crisp on high-DPI screens at the
   * ~520px Discord shows embed images at, for about half the encode time of 2. */
  scale?: number;
  title?: string;
  direction?: ChartDirection;
  /** Short label for the timeframe shown in the header chip, e.g. "1W". */
  timeframe?: string;
  /** Optional market icon URL; embedded inline if it fetches successfully. */
  iconUrl?: string | null;
}

// Dark palette tuned to sit inside a Discord embed. Up/down colors are status
// colors and always ship with a ▲/▼ glyph, so direction is never color-only.
const LINE_COLORS: Record<ChartDirection, string> = {
  up: "#2fbf71",
  down: "#f0524f",
  flat: "#9aa0a6",
};

const BG = "#1e1f22";
const GRID = "#2e3036";
const AXIS_TEXT = "#8d9199";
const TEXT_TITLE = "#f2f3f5";
const TEXT_MUTED = "#a3a7ae";
const CHIP_BG = "#2b2d31";
const CHIP_BORDER = "#3a3c42";
const TAG_TEXT = "#111214";
const FONT = "DejaVu Sans";

export async function renderPriceChart(
  points: PricePoint[],
  opts: ChartOptions = {},
): Promise<Buffer | null> {
  if (points.length < 2) return null;
  const iconDataUri = opts.iconUrl ? await loadChartIcon(opts.iconUrl) : null;
  const svg = buildChartSvg(points, opts, iconDataUri);

  // Identical SVG means an identical PNG. Price history is cached for a
  // minute, so everyone clicking Chart on the same shared card in that window
  // gets the same image and only the first click pays for rasterizing.
  const key = Bun.hash(svg);
  const cached = pngCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.png;

  // Resvg ships without fonts by default — text silently disappears unless
  // we explicitly load system fonts and pick a family the box has.
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: RESOLVED_FONTS,
      // Keep system fonts on as a backstop in case the explicit paths above
      // didn't match (e.g. on a distro we haven't enumerated).
      loadSystemFonts: RESOLVED_FONTS.length === 0,
      defaultFontFamily: FONT,
    },
  });
  const png = Buffer.from(resvg.render().asPng());
  pngCache.set(key, { png, expiresAt: Date.now() + PNG_CACHE_TTL_MS });
  evictOldest(pngCache, PNG_CACHE_MAX);
  return png;
}

const PNG_CACHE_TTL_MS = 60_000;
const PNG_CACHE_MAX = 32;
const pngCache = new Map<number | bigint, { png: Buffer; expiresAt: number }>();

export function buildChartSvg(
  points: PricePoint[],
  opts: ChartOptions,
  iconDataUri: string | null,
): string {
  const first = points[0];
  const last = points[points.length - 1];
  // Caller (renderPriceChart) guarantees points.length >= 2; this guard is for
  // type narrowing, not a runtime branch we expect to take.
  if (!first || !last) return "";

  const width = opts.width ?? 800;
  const height = opts.height ?? 420;
  const scale = opts.scale ?? 1.5;
  const direction = opts.direction ?? "flat";
  const lineColor = LINE_COLORS[direction];
  const timeframe = opts.timeframe ?? "1W";

  const pad = 28;
  const out: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  // Icon (if any) anchors the left; title wraps to two lines beside it, with
  // the price row underneath.
  const headerTop = 24;
  const iconSize = 52;
  const textLeft = iconDataUri ? pad + iconSize + 16 : pad;
  const textRight = width - pad;

  if (iconDataUri) {
    out.push(
      `<defs><clipPath id="iconClip"><rect x="${pad}" y="${headerTop}" width="${iconSize}" height="${iconSize}" rx="12"/></clipPath></defs>`,
      `<rect x="${pad}" y="${headerTop}" width="${iconSize}" height="${iconSize}" rx="12" fill="${CHIP_BG}"/>`,
      `<image href="${iconDataUri}" x="${pad}" y="${headerTop}" width="${iconSize}" height="${iconSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#iconClip)"/>`,
    );
  }

  const titleSize = 17;
  const titleLineHeight = 22;
  const titleLines = opts.title
    ? wrapText(opts.title, textRight - textLeft, titleSize, true, 2)
    : [];
  titleLines.forEach((line, i) => {
    out.push(
      text(
        textLeft,
        headerTop + titleSize - 2 + i * titleLineHeight,
        line,
        titleSize,
        TEXT_TITLE,
        { bold: true },
      ),
    );
  });

  const priceSize = 30;
  const priceBaseline =
    headerTop + titleLines.length * titleLineHeight + priceSize - 2;
  const currentPct = last.p * 100;
  const priceStr = `${currentPct.toFixed(1)}%`;
  out.push(
    text(textLeft, priceBaseline, priceStr, priceSize, TEXT_TITLE, {
      bold: true,
    }),
  );
  let cursor = textLeft + textWidth(priceStr, priceSize, true) + 6;
  out.push(text(cursor, priceBaseline, "chance", 14, TEXT_MUTED));
  cursor += textWidth("chance", 14, false) + 14;

  // Delta chip, tinted with the direction color, then a neutral timeframe chip.
  const chipH = 24;
  const chipY = priceBaseline - 19;
  const deltaPts = (last.p - first.p) * 100;
  const deltaStr =
    direction === "flat"
      ? "No change"
      : `${direction === "up" ? "▲" : "▼"} ${Math.abs(deltaPts).toFixed(1)} pts`;
  const deltaW = textWidth(deltaStr, 13, true) + 20;
  out.push(
    `<rect x="${cursor}" y="${chipY}" width="${f(deltaW)}" height="${chipH}" rx="${chipH / 2}" fill="${lineColor}" fill-opacity="0.15"/>`,
    text(cursor + 10, chipY + 17, deltaStr, 13, lineColor, { bold: true }),
  );
  cursor += deltaW + 8;
  const tfW = textWidth(timeframe, 12, true) + 20;
  out.push(
    `<rect x="${f(cursor)}" y="${chipY}" width="${f(tfW)}" height="${chipH}" rx="${chipH / 2}" fill="${CHIP_BG}" stroke="${CHIP_BORDER}"/>`,
    text(cursor + tfW / 2, chipY + 16.5, timeframe, 12, TEXT_MUTED, {
      bold: true,
      anchor: "middle",
    }),
  );
  cursor += tfW;

  // Range high/low on the right of the price row, when there's room.
  let pMin = Infinity;
  let pMax = -Infinity;
  for (const pt of points) {
    if (pt.p < pMin) pMin = pt.p;
    if (pt.p > pMax) pMax = pt.p;
  }
  const statsStr = `High ${(pMax * 100).toFixed(1)}%  ·  Low ${(pMin * 100).toFixed(1)}%`;
  if (textRight - textWidth(statsStr, 12, false) > cursor + 16) {
    out.push(
      text(textRight, priceBaseline - 3, statsStr, 12, TEXT_MUTED, {
        anchor: "end",
      }),
    );
  }

  const headerBottom = Math.max(
    priceBaseline + 14,
    iconDataUri ? headerTop + iconSize + 8 : 0,
  );

  // ── Plot ──────────────────────────────────────────────────────────────────
  const plotTop = headerBottom + 18;
  const plotBottom = height - 34;
  const plotLeft = pad;
  const plotRight = width - pad - 50; // room for y labels
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  const tMin = first.t;
  const tMax = last.t;
  const tSpan = Math.max(tMax - tMin, 1);
  const xOf = (t: number) => plotLeft + ((t - tMin) / tSpan) * plotW;

  // Auto-scale Y to the data's range, snapped outward to round ticks so the
  // grid spans the plot exactly. Polymarket does the same; a fixed 0–100%
  // flattens most markets into a line.
  const yScale = niceYScale(pMin, pMax);
  const ySpan = Math.max(yScale.hi - yScale.lo, 1e-6);
  const yOf = (p: number) =>
    plotTop + (1 - (clamp01(p) - yScale.lo) / ySpan) * plotH;

  const lastX = xOf(last.t);
  const lastY = yOf(last.p);
  const tagH = 20;
  const yLabelX = plotRight + 10;

  for (const p of yScale.ticks) {
    const y = yOf(p);
    out.push(
      `<line x1="${plotLeft}" y1="${f(y)}" x2="${plotRight}" y2="${f(y)}" stroke="${GRID}" stroke-width="1"/>`,
    );
    // The current-price tag replaces any label it would sit on.
    if (Math.abs(y - lastY) < tagH - 2) continue;
    out.push(
      text(
        yLabelX,
        y + 4,
        `${(p * 100).toFixed(yScale.decimals)}%`,
        11,
        AXIS_TEXT,
      ),
    );
  }

  // X axis: round time ticks (hours for intraday ranges, days, then months).
  const xTicks = timeTicks(tMin, tMax, 6);
  const xLabelY = plotBottom + 22;
  for (const t of xTicks.ticks) {
    const label = formatTimeTick(t, xTicks.step);
    const x = xOf(t);
    const half = textWidth(label, 11, false) / 2;
    if (x - half < plotLeft || x + half > plotRight) continue;
    out.push(
      `<line x1="${f(x)}" y1="${plotBottom}" x2="${f(x)}" y2="${plotBottom + 4}" stroke="${GRID}" stroke-width="1"/>`,
      text(x, xLabelY, label, 11, AXIS_TEXT, { anchor: "middle" }),
    );
  }
  if (xTicks.step < DAY) {
    out.push(
      text(width - pad, xLabelY, "UTC", 11, AXIS_TEXT, { anchor: "end" }),
    );
  }

  // Area + line.
  const coords = points.map((pt) => `${f(xOf(pt.t))},${f(yOf(pt.p))}`);
  out.push(
    `<defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="${lineColor}" stop-opacity="0.28"/>` +
      `<stop offset="1" stop-color="${lineColor}" stop-opacity="0"/>` +
      `</linearGradient></defs>`,
    `<path d="M${f(xOf(first.t))},${plotBottom} L${coords.join(" L")} L${f(lastX)},${plotBottom} Z" fill="url(#areaGrad)"/>`,
    `<polyline points="${coords.join(" ")}" fill="none" stroke="${lineColor}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`,
  );

  // Last-point marker with halo, and the current price tagged on the y axis.
  out.push(
    `<circle cx="${f(lastX)}" cy="${f(lastY)}" r="9" fill="${lineColor}" fill-opacity="0.2"/>`,
    `<circle cx="${f(lastX)}" cy="${f(lastY)}" r="4.5" fill="${lineColor}" stroke="${BG}" stroke-width="2"/>`,
  );
  const tagLabel = `${currentPct.toFixed(yScale.decimals > 0 ? yScale.decimals : 1)}%`;
  const tagW = textWidth(tagLabel, 11, true) + 12;
  const tagY = Math.min(
    Math.max(lastY - tagH / 2, plotTop - tagH / 2),
    plotBottom - tagH / 2,
  );
  out.push(
    `<rect x="${plotRight + 4}" y="${f(tagY)}" width="${f(tagW)}" height="${tagH}" rx="4" fill="${lineColor}"/>`,
    text(plotRight + 10, tagY + 14, tagLabel, 11, TAG_TEXT, { bold: true }),
  );

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * scale}" height="${height * scale}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="${BG}"/>`,
    ...out,
    `</svg>`,
  ].join("");
}

// ─── Text ────────────────────────────────────────────────────────────────────

// Advance widths of DejaVu Sans for ASCII 32–126, in thousandths of an em,
// measured with resvg. Resvg can't measure text for us before layout, so this
// is what lets titles wrap and truncate exactly instead of guessing.
const ADVANCE_REGULAR = [
  318, 401, 460, 838, 636, 950, 780, 275, 390, 390, 500, 838, 318, 361, 301,
  337, 636, 636, 636, 636, 636, 636, 636, 636, 636, 636, 337, 337, 838, 838,
  838, 531, 1000, 684, 686, 699, 770, 632, 575, 775, 752, 295, 295, 656, 557,
  863, 748, 787, 603, 787, 695, 635, 611, 732, 684, 989, 685, 611, 685, 390,
  337, 390, 838, 500, 500, 613, 635, 550, 635, 615, 352, 635, 634, 278, 278,
  579, 278, 974, 634, 612, 635, 635, 411, 521, 392, 634, 592, 818, 592, 592,
  525, 636, 337, 636, 838,
];
const ADVANCE_BOLD = [
  348, 456, 521, 837, 695, 1001, 872, 306, 457, 457, 522, 837, 379, 415, 379,
  365, 695, 695, 695, 695, 695, 695, 695, 695, 695, 695, 399, 399, 837, 837,
  837, 580, 1000, 773, 762, 733, 830, 683, 683, 820, 836, 372, 372, 774, 637,
  995, 836, 850, 732, 850, 770, 720, 682, 812, 773, 1103, 771, 724, 725, 457,
  365, 457, 837, 500, 500, 674, 715, 592, 715, 678, 435, 715, 711, 342, 342,
  665, 342, 1042, 711, 687, 715, 715, 493, 595, 478, 711, 651, 923, 645, 651,
  582, 711, 365, 711, 837,
];

/** Approximate rendered width of `s` in px. Exact for ASCII in DejaVu Sans;
 * other characters get a conservative estimate (wide for CJK). */
export function textWidth(s: string, size: number, bold: boolean): number {
  const table = bold ? ADVANCE_BOLD : ADVANCE_REGULAR;
  let em = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const known = code >= 32 && code <= 126 ? table[code - 32] : undefined;
    if (known !== undefined) em += known;
    else if (code >= 0x2e80) em += 1000;
    else em += bold ? 780 : 720;
  }
  return (em / 1000) * size;
}

/** Greedy word wrap into at most `maxLines` lines no wider than `maxWidth`;
 * the last line is ellipsized if the text doesn't fit. */
export function wrapText(
  s: string,
  maxWidth: number,
  size: number,
  bold: boolean,
  maxLines: number,
): string[] {
  const words = s.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let i = 0;
  while (i < words.length && lines.length < maxLines) {
    let line = words[i] ?? "";
    i++;
    while (i < words.length) {
      const next = `${line} ${words[i]}`;
      if (textWidth(next, size, bold) > maxWidth) break;
      line = next;
      i++;
    }
    lines.push(line);
  }
  const lastIdx = lines.length - 1;
  const lastLine = lines[lastIdx];
  if (lastLine === undefined) return lines;
  const overflow = i < words.length;
  if (overflow || textWidth(lastLine, size, bold) > maxWidth) {
    lines[lastIdx] = ellipsize(
      overflow ? `${lastLine} ${words[i]}` : lastLine,
      maxWidth,
      size,
      bold,
    );
  }
  return lines;
}

function ellipsize(s: string, maxWidth: number, size: number, bold: boolean) {
  const budget = maxWidth - textWidth("…", size, bold);
  let out = "";
  for (const ch of s) {
    if (textWidth(out + ch, size, bold) > budget) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

function text(
  x: number,
  y: number,
  content: string,
  size: number,
  fill: string,
  opts: { bold?: boolean; anchor?: "start" | "middle" | "end" } = {},
): string {
  const weight = opts.bold ? ` font-weight="700"` : "";
  const anchor =
    opts.anchor && opts.anchor !== "start"
      ? ` text-anchor="${opts.anchor}"`
      : "";
  return `<text x="${f(x)}" y="${f(y)}" fill="${fill}" font-size="${size}" font-family="${FONT}"${weight}${anchor}>${escapeSvg(content)}</text>`;
}

// ─── Scales ──────────────────────────────────────────────────────────────────

/** A y-domain around [min, max] (probabilities) with ~`target` round ticks.
 * The domain is snapped outward to tick boundaries and clamped to [0, 1], so
 * the first and last ticks sit exactly on the plot's edges. */
export function niceYScale(
  min: number,
  max: number,
  target = 5,
): { lo: number; hi: number; ticks: number[]; decimals: number } {
  // Work in percentage points so steps land on 1/2/5 × 10^n boundaries that
  // read well next to a "%".
  const padPts = Math.max((max - min) * 100 * 0.12, 0.5);
  const rawLo = Math.max(0, min * 100 - padPts);
  const rawHi = Math.min(100, max * 100 + padPts);
  const step = niceStep((rawHi - rawLo) / Math.max(target - 1, 1));
  const lo = Math.max(0, Math.floor(rawLo / step + 1e-9) * step);
  const hi = Math.min(100, Math.ceil(rawHi / step - 1e-9) * step);
  const ticks: number[] = [];
  const count = Math.round((hi - lo) / step);
  for (let i = 0; i <= count; i++) {
    ticks.push(roundTo(lo + i * step, 6) / 100);
  }
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return { lo: lo / 100, hi: hi / 100, ticks, decimals };
}

function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(rough, 1e-6)));
  const norm = rough / pow;
  if (norm < 1.5) return pow;
  if (norm < 3) return 2 * pow;
  if (norm < 7) return 5 * pow;
  return 10 * pow;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY; // nominal, for comparing steps only
// 1970-01-05 was a Monday; weekly ticks align to Mondays.
const MONDAY_OFFSET = 4 * DAY;
const FIXED_STEPS = [
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
];
const MONTH_STEPS = [1, 2, 3, 6, 12];

/** Round UTC tick times (unix seconds) within [tMin, tMax], at most
 * `maxTicks` of them. `step` is the spacing in seconds (nominal for months). */
export function timeTicks(
  tMin: number,
  tMax: number,
  maxTicks: number,
): { ticks: number[]; step: number } {
  for (const step of FIXED_STEPS) {
    const offset = step >= 7 * DAY ? MONDAY_OFFSET : 0;
    const start = Math.ceil((tMin - offset) / step) * step + offset;
    if (Math.floor((tMax - start) / step) + 1 > maxTicks) continue;
    const ticks: number[] = [];
    for (let t = start; t <= tMax; t += step) ticks.push(t);
    return { ticks, step };
  }
  // Calendar months: ticks on the 1st, at multiples of `months` in the year.
  for (let months = MONTH_STEPS[0] ?? 1; ; ) {
    const ticks = monthTicks(tMin, tMax, months);
    if (ticks.length <= maxTicks) return { ticks, step: months * MONTH };
    months = MONTH_STEPS.find((m) => m > months) ?? months * 2;
  }
}

function monthTicks(tMin: number, tMax: number, months: number): number[] {
  const d = new Date(tMin * 1000);
  let index = d.getUTCFullYear() * 12 + d.getUTCMonth();
  const ticks: number[] = [];
  for (;;) {
    if (index % months === 0) {
      const t = Date.UTC(Math.floor(index / 12), index % 12, 1) / 1000;
      if (t > tMax) break;
      if (t >= tMin) ticks.push(t);
    }
    index++;
  }
  return ticks;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Label for a tick from `timeTicks`: times of day for intraday steps (the
 * date at midnight), dates for day/week steps, months (years at January)
 * beyond that. */
export function formatTimeTick(t: number, step: number): string {
  const d = new Date(t * 1000);
  const month = MONTHS[d.getUTCMonth()];
  const date = `${month} ${d.getUTCDate()}`;
  if (step < DAY) {
    const h = d.getUTCHours();
    const m = d.getUTCMinutes();
    if (h === 0 && m === 0) return date;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  if (step < MONTH) return date;
  return d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : (month ?? "");
}

// ─── Icons ───────────────────────────────────────────────────────────────────

// Market icons almost never change, and fetching one is the slowest step of a
// chart render, so keep them (shrunk, as data URIs) for a few hours. The in-flight
// promise is cached too: a caller can start the fetch early and concurrent
// renders share it.
const ICON_TTL_MS = 6 * 60 * 60_000;
const ICON_FAILURE_TTL_MS = 5 * 60_000;
const ICON_CACHE_MAX = 256;
const iconCache = new Map<
  string,
  { value: Promise<string | null>; expiresAt: number }
>();

/** The icon at `url` as a data URI, or null if it can't be fetched. Never
 * rejects, so it's safe to call ahead of time and not await. */
export function loadChartIcon(url: string): Promise<string | null> {
  const hit = iconCache.get(url);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const entry = {
    value: fetchIconDataUri(url),
    expiresAt: Date.now() + ICON_TTL_MS,
  };
  entry.value.then((uri) => {
    if (uri === null) entry.expiresAt = Date.now() + ICON_FAILURE_TTL_MS;
  });
  iconCache.delete(url);
  iconCache.set(url, entry);
  evictOldest(iconCache, ICON_CACHE_MAX);
  return entry.value;
}

/** Drop the oldest entries (Maps iterate in insertion order) beyond `max`. */
function evictOldest(map: Map<unknown, unknown>, max: number) {
  for (const key of map.keys()) {
    if (map.size <= max) break;
    map.delete(key);
  }
}

// Icons are drawn at 52px (78px at the default 1.5x); keep headroom for 2x.
const ICON_PX = 128;

/** Re-encode an icon as a small PNG. Market images are often full-size
 * photos (hundreds of KB) and decoding one costs more than the rest of the
 * chart, so do it once here rather than on every render. Null if resvg can't
 * decode the image (it renders nothing rather than throwing). */
function shrinkIcon(dataUri: string): string | null {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}"><image href="${dataUri}" width="${ICON_PX}" height="${ICON_PX}" preserveAspectRatio="xMidYMid slice"/></svg>`;
  const rendered = new Resvg(svg, {
    font: { loadSystemFonts: false },
  }).render();
  const { pixels } = rendered;
  let visible = false;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 0) {
      visible = true;
      break;
    }
  }
  if (!visible) return null;
  return `data:image/png;base64,${Buffer.from(rendered.asPng()).toString("base64")}`;
}

async function fetchIconDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const ctype = res.headers.get("content-type") ?? "image/png";
    // Resvg supports raster (png/jpeg) and svg inside <image href>. Skip
    // anything exotic so we don't break the render.
    if (!/^image\/(png|jpe?g|svg\+xml|webp|gif)/i.test(ctype)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return shrinkIcon(`data:${ctype};base64,${buf.toString("base64")}`);
  } catch (err) {
    logger.debug(`chart: icon fetch failed for ${url}: ${String(err)}`);
    return null;
  }
}

// ─── Utils ───────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function roundTo(n: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

/** Format a coordinate for SVG output. */
function f(n: number): string {
  return n.toFixed(1);
}

function escapeSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

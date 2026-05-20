import { existsSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import type { PricePoint } from "../services/polymarket.js";
import { logger } from "../utils/logger.js";
import { truncate } from "./text.js";

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
  width?: number;
  height?: number;
  title?: string;
  direction?: ChartDirection;
  /** Short label for the timeframe shown in the header pill, e.g. "1W". */
  timeframe?: string;
  /** Optional market icon URL; embedded inline if it fetches successfully. */
  iconUrl?: string | null;
}

const LINE_COLORS: Record<ChartDirection, string> = {
  up: "#00cc66",
  down: "#ff4444",
  flat: "#9aa0a6",
};

const BG = "#1f2024";
const PANEL_BORDER = "#3a3c42";
const GRID = "#3a3c42";
const AXIS_TEXT = "#9aa0a6";
const TEXT_TITLE = "#ffffff";
const TEXT_SUB = "#b5bac1";
const PILL_BG = "#2b2d31";

export async function renderPriceChart(
  points: PricePoint[],
  opts: ChartOptions = {},
): Promise<Buffer | null> {
  if (points.length < 2) return null;
  const iconDataUri = opts.iconUrl
    ? await fetchIconDataUri(opts.iconUrl)
    : null;
  const svg = buildChartSvg(points, opts, iconDataUri);
  // Resvg ships without fonts by default — text silently disappears unless
  // we explicitly load system fonts and pick a family the box has.
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: RESOLVED_FONTS,
      // Keep system fonts on as a backstop in case the explicit paths above
      // didn't match (e.g. on a distro we haven't enumerated).
      loadSystemFonts: RESOLVED_FONTS.length === 0,
      defaultFontFamily: "DejaVu Sans",
    },
  });
  return Buffer.from(resvg.render().asPng());
}

function buildChartSvg(
  points: PricePoint[],
  opts: ChartOptions,
  iconDataUri: string | null,
): string {
  const first = points[0];
  const last = points[points.length - 1];
  // Caller (renderPriceChart) guarantees points.length >= 2; this guard is for
  // type narrowing, not a runtime branch we expect to take.
  if (!first || !last) return "";

  const width = opts.width ?? 700;
  const height = opts.height ?? 380;
  const direction = opts.direction ?? "flat";
  const lineColor = LINE_COLORS[direction];
  const timeframe = opts.timeframe ?? "1W";

  // Layout
  const header = 92;
  const top = header + 10;
  const right = 56;
  const bottom = 38;
  const left = 24;
  const chartW = width - left - right;
  const chartH = height - top - bottom;

  // Header geometry — icon (if present) anchors the left of the header block;
  // title/subtitle/price stack to its right.
  const iconSize = 44;
  const iconX = left;
  const iconY = 20;
  const textLeft = iconDataUri ? iconX + iconSize + 12 : left;

  const tMin = first.t;
  const tMax = last.t;
  const tSpan = Math.max(tMax - tMin, 1);
  const xOf = (t: number) => left + ((t - tMin) / tSpan) * chartW;

  // Auto-scale Y to the data's actual range (with padding) instead of always
  // 0–100%. For narrow markets this makes movement visible; Polymarket does
  // the same. Pad by 15% of range, with a 1pp floor for near-flat lines.
  let pMin = Infinity;
  let pMax = -Infinity;
  for (const pt of points) {
    if (pt.p < pMin) pMin = pt.p;
    if (pt.p > pMax) pMax = pt.p;
  }
  const dataSpan = pMax - pMin;
  const pad = Math.max(dataSpan * 0.15, 0.01);
  const yMin = Math.max(0, pMin - pad);
  const yMax = Math.min(1, pMax + pad);
  const ySpan = Math.max(yMax - yMin, 0.0001);
  const yOf = (p: number) => top + (1 - (clamp01(p) - yMin) / ySpan) * chartH;
  const yTicks = niceTicks(yMin, yMax, 5);

  const lastX = xOf(last.t);
  const lastY = yOf(last.p);

  const linePoints = points
    .map((pt) => `${xOf(pt.t).toFixed(1)},${yOf(pt.p).toFixed(1)}`)
    .join(" ");

  const baseline = top + chartH;
  const areaPath =
    `M ${xOf(first.t).toFixed(1)},${baseline.toFixed(1)} ` +
    points
      .map((pt) => `L ${xOf(pt.t).toFixed(1)},${yOf(pt.p).toFixed(1)}`)
      .join(" ") +
    ` L ${lastX.toFixed(1)},${baseline.toFixed(1)} Z`;

  // Y-axis grid uses the computed nice ticks for the visible range. End ticks
  // (top/bottom of the visible band) are solid; interior ticks are dashed.
  const tickLabel = formatPctTick(yTicks);
  const gridLines = yTicks
    .map((p, i) => {
      const dashed = i !== 0 && i !== yTicks.length - 1;
      const y = yOf(p).toFixed(1);
      const labelY = (yOf(p) + 4).toFixed(1);
      const dash = dashed ? ` stroke-dasharray="2,4"` : "";
      return (
        `<line x1="${left}" y1="${y}" x2="${left + chartW}" y2="${y}" stroke="${GRID}" stroke-width="1"${dash}/>` +
        `<text x="${left + chartW + 8}" y="${labelY}" fill="${AXIS_TEXT}" font-size="10" font-family="DejaVu Sans">${tickLabel(p)}</text>`
      );
    })
    .join("");

  // X-axis: 4 evenly spaced date ticks.
  const tickCount = 4;
  const timeY = (top + chartH + 18).toFixed(1);
  const xTicks: string[] = [];
  for (let i = 0; i < tickCount; i++) {
    const frac = i / (tickCount - 1);
    const t = tMin + frac * tSpan;
    const x = (left + frac * chartW).toFixed(1);
    const anchor = i === 0 ? "start" : i === tickCount - 1 ? "end" : "middle";
    xTicks.push(
      `<text x="${x}" y="${timeY}" fill="${AXIS_TEXT}" font-size="10" font-family="DejaVu Sans" text-anchor="${anchor}">${formatDate(t)}</text>`,
    );
  }

  // Last-point marker with halo.
  const marker =
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="8" fill="${lineColor}" fill-opacity="0.18"/>` +
    `<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.5" fill="${lineColor}" stroke="${BG}" stroke-width="1.5"/>`;

  // Header content
  const currentPct = last.p * 100;
  const startPct = first.p * 100;
  const deltaPct = currentPct - startPct;
  const arrow = deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "•";
  const deltaSign = deltaPct > 0 ? "+" : "";
  const deltaStr = `${arrow} ${deltaSign}${deltaPct.toFixed(2)} pts`;

  // Timeframe pill (top-right) — reserve space so the title can wrap-truncate
  // before colliding with it.
  const pillW = 44;
  const pillH = 22;
  const pillY = 22;
  const pillX = width - right - pillW + 16;
  const pillSvg =
    `<rect x="${pillX}" y="${pillY}" width="${pillW}" height="${pillH}" rx="11" ry="11" fill="${PILL_BG}" stroke="${PANEL_BORDER}" stroke-width="1"/>` +
    `<text x="${pillX + pillW / 2}" y="${pillY + 15}" fill="${TEXT_SUB}" font-size="11" font-weight="600" font-family="DejaVu Sans" text-anchor="middle">${escapeSvg(timeframe)}</text>`;

  // Crude character budget so titles don't run under the pill. ~6.5px/char at
  // 14px DejaVu Sans is a decent approximation.
  const titleBudgetPx = pillX - textLeft - 12;
  const titleMaxChars = Math.max(16, Math.floor(titleBudgetPx / 6.5));
  const titleText = opts.title ? truncate(opts.title, titleMaxChars) : "";
  const titleSvg = titleText
    ? `<text x="${textLeft}" y="34" fill="${TEXT_TITLE}" font-size="14" font-weight="600" font-family="DejaVu Sans">${escapeSvg(titleText)}</text>`
    : "";

  // "YES probability" subtitle (below title)
  const subtitleSvg = `<text x="${textLeft}" y="54" fill="${TEXT_SUB}" font-size="11" font-family="DejaVu Sans">YES probability</text>`;

  // Big current price (below subtitle)
  const bigPriceSvg = `<text x="${textLeft}" y="80" fill="${lineColor}" font-size="22" font-weight="700" font-family="DejaVu Sans">${currentPct.toFixed(1)}%</text>`;

  // Delta (right of big price)
  const deltaSvg = `<text x="${textLeft + 92}" y="80" fill="${lineColor}" font-size="12" font-weight="600" font-family="DejaVu Sans">${deltaStr}</text>`;

  // Icon — clipped to a rounded square. clipPath id is local to this SVG.
  const iconSvg = iconDataUri
    ? `<defs><clipPath id="iconClip"><rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="8" ry="8"/></clipPath></defs>` +
      `<rect x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" rx="8" ry="8" fill="${PILL_BG}" stroke="${PANEL_BORDER}" stroke-width="1"/>` +
      `<image href="${iconDataUri}" x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#iconClip)"/>`
    : "";

  // Header divider — span the chart band cleanly.
  const dividerY = header;
  const dividerSvg = `<line x1="${left}" y1="${dividerY}" x2="${left + chartW}" y2="${dividerY}" stroke="${PANEL_BORDER}" stroke-width="1"/>`;

  // Gradient definitions
  const gradId = "areaGrad";
  const defs =
    `<defs>` +
    `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="${lineColor}" stop-opacity="0.35"/>` +
    `<stop offset="100%" stop-color="${lineColor}" stop-opacity="0.02"/>` +
    `</linearGradient>` +
    `</defs>`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    defs,
    `<rect width="${width}" height="${height}" fill="${BG}"/>`,
    iconSvg,
    titleSvg,
    subtitleSvg,
    bigPriceSvg,
    deltaSvg,
    pillSvg,
    dividerSvg,
    gridLines,
    `<path d="${areaPath}" fill="url(#${gradId})"/>`,
    `<polyline points="${linePoints}" fill="none" stroke="${lineColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    marker,
    xTicks.join(""),
    `</svg>`,
  ].join("");
}

function formatDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const months = [
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
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Pick "nice" round tick values across [min, max] aiming for ~`target`
 * ticks. Operates on percentage points (0–100) internally so we can land on
 * round 1/2/5/10 boundaries that look right next to a "%" label. */
function niceTicks(min: number, max: number, target: number): number[] {
  const lo = min * 100;
  const hi = max * 100;
  const span = Math.max(hi - lo, 0.01);
  const rough = span / Math.max(target - 1, 1);
  // Snap step to a 1/2/5 × 10^n boundary.
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  let step: number;
  if (norm < 1.5) step = 1 * pow;
  else if (norm < 3) step = 2 * pow;
  else if (norm < 7) step = 5 * pow;
  else step = 10 * pow;
  const start = Math.ceil(lo / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) {
    ticks.push(v / 100);
  }
  // If the band edge is meaningfully outside the nearest snapped tick, pin it
  // so the grid spans the full chart. The threshold is ~25% of one step;
  // closer than that, the duplicate label would just visually crowd the edge.
  const stepFrac = step / 100;
  if (ticks.length === 0 || ticks[0]! - min > stepFrac * 0.25) {
    ticks.unshift(min);
  }
  if (ticks.length === 0 || max - ticks[ticks.length - 1]! > stepFrac * 0.25) {
    ticks.push(max);
  }
  return ticks;
}

/** Decide decimal places for tick labels based on the visible step size, then
 * return a formatter. Sub-percent steps need decimals so labels don't repeat. */
function formatPctTick(ticks: number[]): (p: number) => string {
  let minStep = Infinity;
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i];
    const b = ticks[i - 1];
    if (a === undefined || b === undefined) continue;
    const d = Math.abs(a - b);
    if (d > 0 && d < minStep) minStep = d;
  }
  const stepPct = minStep * 100;
  let decimals = 0;
  if (stepPct < 0.1) decimals = 2;
  else if (stepPct < 1) decimals = 1;
  return (p: number) => `${(p * 100).toFixed(decimals)}%`;
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
    return `data:${ctype};base64,${buf.toString("base64")}`;
  } catch (err) {
    logger.debug(`chart: icon fetch failed for ${url}: ${String(err)}`);
    return null;
  }
}

function escapeSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

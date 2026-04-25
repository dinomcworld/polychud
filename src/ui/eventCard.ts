import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import type { GammaEvent } from "../services/polymarket.js";
import { escapeMarkdown, type SearchResultItem } from "./marketCard.js";

export interface EventCardData {
  polyEventId: string;
  title: string;
  slug: string | null;
  imageUrl: string | null;
  endDate: Date | null;
  status: string;
  volume24h: number | null;
  outcomes: EventOutcome[];
}

export interface EventOutcome {
  conditionId: string;
  label: string;
  yesPrice: number;
  status: string;
  endDate: Date | null;
}

export function buildEventEmbed(event: EventCardData, showResolved = false) {
  const filtered = showResolved
    ? event.outcomes
    : event.outcomes.filter(
        (o) => o.status !== "resolved" && o.status !== "closed",
      );

  const display = filtered.length > 0 ? filtered : event.outcomes;
  const sorted = [...display].sort((a, b) => b.yesPrice - a.yesPrice);

  const MAX_LINES = 20;
  const MAX_DESC = 4096;
  const capped = sorted.slice(0, MAX_LINES);
  const truncatedCount = sorted.length - capped.length;

  const lines = capped.map((o) => {
    const pct = o.yesPrice * 100;
    const bar = buildProgressBar(pct);
    const resolved =
      o.status === "resolved" || o.status === "closed" ? " *(Resolved)*" : "";
    return `${bar} **${pct.toFixed(1)}%** — ${escapeMarkdown(o.label)}${resolved}`;
  });
  if (truncatedCount > 0) {
    lines.push(
      `_…and ${truncatedCount} more outcome${truncatedCount !== 1 ? "s" : ""}_`,
    );
  }

  let description = lines.join("\n");
  if (description.length > MAX_DESC) {
    description = `${description.slice(0, MAX_DESC - 1)}…`;
  }

  const eventUrl = event.slug
    ? `https://polymarket.com/event/${event.slug}`
    : "https://polymarket.com";

  const rawTitle =
    event.title.length > 256 ? `${event.title.slice(0, 253)}...` : event.title;
  const title = escapeMarkdown(rawTitle);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(eventUrl)
    .setColor(event.status === "active" ? 0x5865f2 : 0x888888)
    .setDescription(description)
    .setFooter({ text: "Select an outcome to bet on" })
    .setTimestamp();

  if (event.volume24h != null) {
    embed.addFields({
      name: "24h Volume",
      value: formatVolume(event.volume24h),
      inline: true,
    });
  }

  // Use the latest end date among active sub-markets
  const activeEndDates = event.outcomes
    .filter(
      (o): o is typeof o & { endDate: Date } =>
        o.status === "active" && o.endDate !== null,
    )
    .map((o) => o.endDate.getTime());
  const latestEndDate =
    activeEndDates.length > 0
      ? new Date(Math.max(...activeEndDates))
      : event.endDate;

  if (latestEndDate) {
    const unix = Math.floor(latestEndDate.getTime() / 1000);
    embed.addFields({
      name: "Closes",
      value: `<t:${unix}:R>`,
      inline: true,
    });
  }

  if (event.imageUrl) {
    embed.setThumbnail(event.imageUrl);
  }

  // Indicate if some outcomes are hidden
  const hiddenCount = event.outcomes.length - display.length;
  if (hiddenCount > 0) {
    embed.setFooter({
      text: `${hiddenCount} resolved outcome${hiddenCount !== 1 ? "s" : ""} hidden · Select an outcome to bet on`,
    });
  }

  return embed;
}

export function buildEventSelectMenu(
  event: EventCardData,
  showResolved = false,
) {
  const filtered = showResolved
    ? event.outcomes
    : event.outcomes.filter(
        (o) => o.status !== "resolved" && o.status !== "closed",
      );

  const display = filtered.length > 0 ? filtered : event.outcomes;
  const selectable = display.filter((o) => o.conditionId);
  const sorted = [...selectable].sort((a, b) => b.yesPrice - a.yesPrice);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`event_select_${event.polyEventId}`)
    .setPlaceholder("Select an outcome to bet on...")
    .addOptions(
      sorted.slice(0, 25).map((o) => {
        const pct = (o.yesPrice * 100).toFixed(1);
        const label =
          o.label.length > 100 ? `${o.label.slice(0, 97)}...` : o.label;
        const desc =
          o.status === "resolved" || o.status === "closed"
            ? "Resolved"
            : `Currently ${pct}%`;
        return {
          label,
          description: desc,
          value: o.conditionId,
        };
      }),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildEventButtons(
  polyEventId: string,
  slug: string | null,
  showResolved = false,
  hasHiddenOutcomes = false,
) {
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`refresh_event_${polyEventId}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
  );

  if (hasHiddenOutcomes || showResolved) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(
          showResolved
            ? `hide_resolved_${polyEventId}`
            : `show_resolved_${polyEventId}`,
        )
        .setLabel(showResolved ? "Hide Resolved" : "Show Resolved")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (slug) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Polymarket")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://polymarket.com/event/${slug}`),
    );
  }

  return row;
}

export function buildBackToEventButton(polyEventId: string) {
  return new ButtonBuilder()
    .setCustomId(`back_event_${polyEventId}`)
    .setLabel("Back to Event")
    .setStyle(ButtonStyle.Secondary);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildProgressBar(pct: number): string {
  const filled = Math.round(pct / 10);
  const empty = 10 - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty);
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`;
  return `$${vol.toFixed(0)}`;
}

/** Extract a short outcome label from a sub-market question or groupItemTitle. */
export function extractOutcomeLabel(
  question: string,
  groupItemTitle?: string | null,
): string {
  if (groupItemTitle) return groupItemTitle;

  // Try to extract the subject from common patterns
  let label = question;

  // "Will X win/be/become...?" → X
  const willMatch = label.match(
    /^Will\s+(?:the\s+)?(.+?)\s+(?:win|be |become |happen|occur|pass|reach|hit|exceed|go )/i,
  );
  if (willMatch?.[1]) return willMatch[1];

  // "X to win/be...?" → X
  const toMatch = label.match(/^(.+?)\s+to\s+(?:win|be |become )/i);
  if (toMatch?.[1]) return toMatch[1];

  // Fallback: truncate
  if (label.length > 40) label = `${label.slice(0, 37)}...`;
  return label;
}

/** Project a Gamma API event into the shape buildEventEmbed expects. */
export function buildEventCardFromGamma(gamma: GammaEvent): EventCardData {
  const outcomes: EventOutcome[] = gamma.markets.map((m) => {
    const mStatus = m.closed ? "closed" : m.active ? "active" : "inactive";
    return {
      conditionId: m.conditionId,
      label: extractOutcomeLabel(m.question, m.groupItemTitle),
      yesPrice: m.outcomePrices[0] ?? 0.5,
      status: mStatus,
      endDate: m.endDate ? new Date(m.endDate) : null,
    };
  });

  return {
    polyEventId: gamma.id,
    title: gamma.title,
    slug: gamma.slug,
    imageUrl: gamma.image || gamma.icon || null,
    endDate: gamma.endDate ? new Date(gamma.endDate) : null,
    status: gamma.closed ? "closed" : gamma.active ? "active" : "inactive",
    volume24h: gamma.volume24hr ?? null,
    outcomes,
  };
}

/** Project a list of Gamma events into displayable search items. Multi-market
 * events collapse to their leading sub-market (highest YES price). */
export function eventsToSearchItems(
  gammaEvents: GammaEvent[],
): SearchResultItem[] {
  const items: SearchResultItem[] = [];
  for (const event of gammaEvents) {
    const eventStatus = event.closed
      ? "closed"
      : event.active
        ? "active"
        : "inactive";

    if (event.markets.length > 1) {
      const activeMarkets = event.markets.filter((m) => m.active && !m.closed);
      const marketsToCheck =
        activeMarkets.length > 0 ? activeMarkets : event.markets;
      const [firstMarket] = marketsToCheck;
      if (!firstMarket) continue;
      const frontrunner = marketsToCheck.reduce((best, m) => {
        const price = m.outcomePrices[0] ?? 0;
        return price > (best.outcomePrices[0] ?? 0) ? m : best;
      }, firstMarket);

      const frontrunnerLabel = extractOutcomeLabel(
        frontrunner.question,
        frontrunner.groupItemTitle,
      );
      items.push({
        conditionId: frontrunner.conditionId,
        question: event.title,
        yesPrice: frontrunner.outcomePrices[0] ?? 0.5,
        outcomeLabel: frontrunnerLabel,
        status: eventStatus,
        eventSlug: event.slug ?? null,
        volume24h: event.volume24hr ?? null,
        outcomeCount: event.markets.length,
      });
    } else if (event.markets.length === 1) {
      const [m] = event.markets;
      if (!m) continue;
      items.push({
        conditionId: m.conditionId,
        question: m.question,
        yesPrice: m.outcomePrices[0] ?? 0.5,
        outcomeLabel: m.groupItemTitle || null,
        status: eventStatus,
        eventSlug: event.slug ?? null,
        volume24h: event.volume24hr ?? m.volume24hr ?? null,
      });
    }
  }
  return items;
}

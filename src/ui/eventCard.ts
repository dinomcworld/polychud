import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { escapeMarkdown } from "./marketCard.js";

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
        (o) => o.status !== "resolved" && o.status !== "closed"
      );

  const display = filtered.length > 0 ? filtered : event.outcomes;
  const sorted = [...display].sort((a, b) => b.yesPrice - a.yesPrice);

  const lines = sorted.map((o) => {
    const pct = o.yesPrice * 100;
    const bar = buildProgressBar(pct);
    const resolved =
      o.status === "resolved" || o.status === "closed" ? " *(Resolved)*" : "";
    return `${bar} **${pct.toFixed(1)}%** — ${escapeMarkdown(o.label)}${resolved}`;
  });

  const eventUrl = event.slug
    ? `https://polymarket.com/event/${event.slug}`
    : "https://polymarket.com";

  const rawTitle =
    event.title.length > 256
      ? event.title.slice(0, 253) + "..."
      : event.title;
  const title = escapeMarkdown(rawTitle);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(eventUrl)
    .setColor(event.status === "active" ? 0x5865f2 : 0x888888)
    .setDescription(lines.join("\n"))
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
    .filter((o) => o.status === "active" && o.endDate)
    .map((o) => o.endDate!.getTime());
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
  showResolved = false
) {
  const filtered = showResolved
    ? event.outcomes
    : event.outcomes.filter(
        (o) => o.status !== "resolved" && o.status !== "closed"
      );

  const display = filtered.length > 0 ? filtered : event.outcomes;
  const sorted = [...display].sort((a, b) => b.yesPrice - a.yesPrice);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`event_select_${event.polyEventId}`)
    .setPlaceholder("Select an outcome to bet on...")
    .addOptions(
      sorted.slice(0, 25).map((o) => {
        const pct = (o.yesPrice * 100).toFixed(1);
        const label =
          o.label.length > 100 ? o.label.slice(0, 97) + "..." : o.label;
        const desc =
          o.status === "resolved" || o.status === "closed"
            ? "Resolved"
            : `Currently ${pct}%`;
        return {
          label,
          description: desc,
          value: o.conditionId,
        };
      })
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildEventButtons(
  polyEventId: string,
  slug: string | null,
  showResolved = false,
  hasHiddenOutcomes = false
) {
  const row = new ActionRowBuilder<ButtonBuilder>();

  row.addComponents(
    new ButtonBuilder()
      .setCustomId(`refresh_event_${polyEventId}`)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary)
  );

  if (hasHiddenOutcomes || showResolved) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(
          showResolved
            ? `hide_resolved_${polyEventId}`
            : `show_resolved_${polyEventId}`
        )
        .setLabel(showResolved ? "Hide Resolved" : "Show Resolved")
        .setStyle(ButtonStyle.Secondary)
    );
  }

  if (slug) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Polymarket")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://polymarket.com/event/${slug}`)
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
  groupItemTitle?: string | null
): string {
  if (groupItemTitle) return groupItemTitle;

  // Try to extract the subject from common patterns
  let label = question;

  // "Will X win/be/become...?" → X
  const willMatch = label.match(
    /^Will\s+(?:the\s+)?(.+?)\s+(?:win|be |become |happen|occur|pass|reach|hit|exceed|go )/i
  );
  if (willMatch) return willMatch[1]!;

  // "X to win/be...?" → X
  const toMatch = label.match(
    /^(.+?)\s+to\s+(?:win|be |become )/i
  );
  if (toMatch) return toMatch[1]!;

  // Fallback: truncate
  if (label.length > 40) label = label.slice(0, 37) + "...";
  return label;
}

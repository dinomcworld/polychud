import {
  ActionRowBuilder,
  type APIEmbedField,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from "discord.js";

interface MarketCardData {
  conditionId: string;
  question: string;
  slug: string | null;
  eventSlug: string | null;
  yesPrice: number;
  noPrice: number;
  volume24h: string | null;
  endDate: Date | null;
  imageUrl: string | null;
  status: string;
  outcomeLabel: string | null;
}

export function buildMarketEmbed(market: MarketCardData) {
  const yesPct = (market.yesPrice * 100).toFixed(1);
  const noPct = (market.noPrice * 100).toFixed(1);

  const rawTitle = market.outcomeLabel
    ? `${market.outcomeLabel} — ${market.question}`
    : market.question;
  const title = escapeMarkdown(rawTitle);

  const linkSlug = market.eventSlug || market.slug;
  const marketUrl = linkSlug
    ? `https://polymarket.com/event/${linkSlug}`
    : "https://polymarket.com";

  const embed = new EmbedBuilder()
    .setTitle(title.length > 256 ? `${title.slice(0, 253)}...` : title)
    .setURL(marketUrl)
    .setColor(market.status === "active" ? 0x00cc66 : 0x888888)
    .setFooter({ text: "Virtual betting \u2022 Not real money" })
    .setTimestamp();

  const fields: APIEmbedField[] = [
    { name: "YES", value: `${yesPct}%`, inline: true },
    { name: "NO", value: `${noPct}%`, inline: true },
  ];

  if (market.volume24h) {
    const vol = parseFloat(market.volume24h);
    fields.push({
      name: "24h Volume",
      value: formatVolume(vol),
      inline: true,
    });
  }

  if (market.endDate) {
    const unix = Math.floor(market.endDate.getTime() / 1000);
    fields.push({
      name: "Closes",
      value: `<t:${unix}:R>`,
      inline: true,
    });
  }

  embed.addFields(fields);

  if (market.imageUrl) {
    embed.setThumbnail(market.imageUrl);
  }

  return embed;
}

export function buildMarketButtons(
  conditionId: string,
  slug: string | null,
  isActive: boolean,
  eventSlug?: string | null,
  polyEventId?: string | null,
) {
  const row = new ActionRowBuilder<ButtonBuilder>();

  if (isActive) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`bet_yes_${conditionId}`)
        .setLabel("Bet YES")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`bet_no_${conditionId}`)
        .setLabel("Bet NO")
        .setStyle(ButtonStyle.Danger),
    );
  }

  // Embed polyEventId in refresh button so event context survives refresh
  const refreshId = polyEventId
    ? `refresh_${conditionId}_evt${polyEventId}`
    : `refresh_${conditionId}`;
  row.addComponents(
    new ButtonBuilder()
      .setCustomId(refreshId)
      .setLabel("Refresh")
      .setStyle(ButtonStyle.Secondary),
  );

  const linkSlug = eventSlug || slug;
  if (linkSlug) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Polymarket")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://polymarket.com/event/${linkSlug}`),
    );
  }

  return row;
}

export interface SearchResultItem {
  conditionId: string;
  question: string;
  yesPrice: number;
  outcomeLabel: string | null;
  status?: string;
  eventSlug?: string | null;
  volume24h?: number | null;
  outcomeCount?: number;
}

export const SEARCH_PAGE_SIZE = 10;

export function paginateSearchResults(
  results: SearchResultItem[],
  showResolved: boolean,
): SearchResultItem[] {
  const filtered = showResolved
    ? results
    : results.filter((r) => r.status !== "resolved" && r.status !== "closed");
  return filtered.length > 0 ? filtered : results;
}

export function buildSearchResultsEmbed(
  query: string,
  results: SearchResultItem[],
  showResolved = false,
  page = 0,
) {
  const display = paginateSearchResults(results, showResolved);
  const hiddenCount = results.length - display.length;
  const totalPages = Math.max(1, Math.ceil(display.length / SEARCH_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * SEARCH_PAGE_SIZE;
  const pageItems = display.slice(start, start + SEARCH_PAGE_SIZE);

  const lines = pageItems.map((r, i) => {
    const idx = start + i + 1;
    const trimmed =
      r.question.length > 80 ? `${r.question.slice(0, 77)}...` : r.question;
    const linkText = trimmed.replace(/\[/g, "(").replace(/\]/g, ")");
    const titleLine = r.eventSlug
      ? `**${idx}.** **[${linkText}](https://polymarket.com/event/${r.eventSlug})**`
      : `**${idx}.** **${escapeMarkdown(trimmed)}**`;

    const meta: string[] = [];
    const isResolved = r.status === "resolved" || r.status === "closed";

    if (isResolved) {
      meta.push("*Resolved*");
      if (r.outcomeLabel) meta.push(escapeMarkdown(r.outcomeLabel));
    } else if (r.outcomeCount && r.outcomeCount > 1) {
      if (r.outcomeLabel) {
        const pct = (r.yesPrice * 100).toFixed(0);
        meta.push(`${escapeMarkdown(r.outcomeLabel)} **${pct}%**`);
      }
      meta.push(`${r.outcomeCount} outcomes`);
    } else {
      if (r.outcomeLabel) meta.push(escapeMarkdown(r.outcomeLabel));
      const pct = (r.yesPrice * 100).toFixed(1);
      meta.push(`**${pct}%** YES`);
    }

    if (r.volume24h && r.volume24h > 0) {
      meta.push(`${formatVolume(r.volume24h)} vol`);
    }

    return `${titleLine}\n${meta.join(" \u00b7 ")}`;
  });

  const parts = [`${display.length} result${display.length !== 1 ? "s" : ""}`];
  if (totalPages > 1) parts.push(`Page ${safePage + 1}/${totalPages}`);
  if (hiddenCount > 0) parts.push(`${hiddenCount} resolved hidden`);
  parts.push("Select one to view details");

  return new EmbedBuilder()
    .setTitle(`Search: "${query}"`)
    .setDescription(lines.join("\n\n"))
    .setColor(0x5865f2)
    .setFooter({ text: parts.join(" \u2022 ") });
}

export function buildSearchSelectMenu(
  results: SearchResultItem[],
  showResolved = false,
  page = 0,
) {
  const display = paginateSearchResults(results, showResolved);
  const totalPages = Math.max(1, Math.ceil(display.length / SEARCH_PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const start = safePage * SEARCH_PAGE_SIZE;
  const pageItems = display.slice(start, start + SEARCH_PAGE_SIZE);
  const items = pageItems.length > 0 ? pageItems : display;

  const menu = new StringSelectMenuBuilder()
    .setCustomId("market_select")
    .setPlaceholder("Select a market to view...")
    .addOptions(
      items.slice(0, 25).map((r) => {
        const pct = (r.yesPrice * 100).toFixed(1);
        const label = r.outcomeLabel
          ? `${r.outcomeLabel}: ${r.question}`
          : r.question;
        const desc =
          r.status === "resolved" || r.status === "closed"
            ? "Resolved"
            : `${pct}% YES`;
        return {
          label: label.length > 100 ? `${label.slice(0, 97)}...` : label,
          description: desc,
          value: r.conditionId,
        };
      }),
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export function buildSearchControlsRow(
  query: string,
  showResolved: boolean,
  hasResolved: boolean,
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> | null {
  const buttons: ButtonBuilder[] = [];
  // Discord caps customId at 100 chars; encode query and clip.
  const encoded = encodeURIComponent(query).slice(0, 60);
  const resolvedFlag = showResolved ? "1" : "0";

  if (totalPages > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`search_page_${page - 1}_${resolvedFlag}_${encoded}`)
        .setLabel("◀ Prev")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`search_page_${page + 1}_${resolvedFlag}_${encoded}`)
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1),
    );
  }

  if (hasResolved || showResolved) {
    const prefix = showResolved
      ? "hide_search_resolved_"
      : "show_search_resolved_";
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`${prefix}${encoded}`)
        .setLabel(showResolved ? "Hide Resolved" : "Show Resolved")
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (buttons.length === 0) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

export function buildTrendingControlsRow(
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> | null {
  if (totalPages <= 1) return null;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`trending_page_${page - 1}`)
      .setLabel("◀ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`trending_page_${page + 1}`)
      .setLabel("Next ▶")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1),
  );
  return row;
}

export function computeSearchPages(
  results: SearchResultItem[],
  showResolved: boolean,
): number {
  const display = paginateSearchResults(results, showResolved);
  return Math.max(1, Math.ceil(display.length / SEARCH_PAGE_SIZE));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatVolume(vol: number): string {
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`;
  return `$${vol.toFixed(0)}`;
}

/** Escape Discord markdown characters in user-facing text. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*~`|\\])/g, "\\$1");
}

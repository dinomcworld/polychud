import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type APIEmbedField,
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
    .setTitle(title.length > 256 ? title.slice(0, 253) + "..." : title)
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
  polyEventId?: string | null
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
        .setStyle(ButtonStyle.Danger)
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
      .setStyle(ButtonStyle.Secondary)
  );

  const linkSlug = eventSlug || slug;
  if (linkSlug) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Polymarket")
        .setStyle(ButtonStyle.Link)
        .setURL(`https://polymarket.com/event/${linkSlug}`)
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
}

export function buildSearchResultsEmbed(
  query: string,
  results: SearchResultItem[]
) {
  const lines = results.slice(0, 10).map((r, i) => {
    const q = escapeMarkdown(
      r.question.length > 60 ? r.question.slice(0, 57) + "..." : r.question
    );

    // Show resolved/closed status
    if (r.status === "resolved" || r.status === "closed") {
      const label = r.outcomeLabel
        ? `${escapeMarkdown(r.outcomeLabel)}: `
        : "";
      return `**${i + 1}.** ${label}${q} — *Resolved*`;
    }

    // Multi-outcome items already have frontrunner info in outcomeLabel
    if (r.outcomeLabel && r.outcomeLabel.includes(" outcomes")) {
      return `**${i + 1}.** ${q} — ${escapeMarkdown(r.outcomeLabel)}`;
    }

    const label = r.outcomeLabel ? `${escapeMarkdown(r.outcomeLabel)}: ` : "";
    const pct = (r.yesPrice * 100).toFixed(1);
    return `**${i + 1}.** ${label}${q} — **${pct}%** YES`;
  });

  return new EmbedBuilder()
    .setTitle(`Search: "${query}"`)
    .setDescription(lines.join("\n"))
    .setColor(0x5865f2)
    .setFooter({
      text: `${results.length} result${results.length !== 1 ? "s" : ""} \u2022 Select one to view details`,
    });
}

export function buildSearchSelectMenu(results: SearchResultItem[]) {
  // Filter to only active markets for the select menu
  const activeResults = results.filter(
    (r) => !r.status || r.status === "active"
  );
  const items = activeResults.length > 0 ? activeResults : results;

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
          label: label.length > 100 ? label.slice(0, 97) + "..." : label,
          description: desc,
          value: r.conditionId,
        };
      })
    );

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
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

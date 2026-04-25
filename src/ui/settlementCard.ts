import { EmbedBuilder, type User } from "discord.js";
import type { NewSettlement } from "../services/betting.js";
import { COLORS } from "./colors.js";
import { escapeMarkdown } from "./marketCard.js";
import { truncate } from "./text.js";

export interface SettlementsEmbedInput {
  user: User;
  settlements: NewSettlement[];
  netPts: number;
  count: number;
  thumbnailUrl?: string | null;
}

const MAX_DESC = 3800;
const MAX_QUESTION = 120;

function statusLabel(status: string): string {
  switch (status) {
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    case "cancelled":
      return "REFUNDED";
    default:
      return status.toUpperCase();
  }
}

function renderEntry(s: NewSettlement): string {
  const pnl = s.actualPayout - s.amount;
  const pnlStr = pnl >= 0 ? `+${pnl.toLocaleString()}` : pnl.toLocaleString();
  const marketTitle = escapeMarkdown(truncate(s.marketQuestion, MAX_QUESTION));
  const marketLine = s.eventSlug
    ? `[${marketTitle}](https://polymarket.com/event/${s.eventSlug})`
    : marketTitle;
  return [
    `**${marketLine}**`,
    `#${s.betId} — ${s.outcome.toUpperCase()} · ${statusLabel(s.status)} · Stake **${s.amount.toLocaleString()}** → **${s.actualPayout.toLocaleString()}** pts (**${pnlStr}**)`,
  ].join("\n");
}

export function buildSettlementsEmbed(
  input: SettlementsEmbedInput,
): EmbedBuilder {
  const { user, settlements, netPts, count, thumbnailUrl } = input;
  const sign = netPts >= 0 ? "+" : "";
  const color = netPts >= 0 ? COLORS.GREEN : COLORS.RED;

  const entries = settlements.map(renderEntry);

  const descLines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const e of entries) {
    const addLen = e.length + (descLines.length > 0 ? 2 : 0);
    if (used + addLen > MAX_DESC) break;
    descLines.push(e);
    used += addLen;
    shown++;
  }
  const remaining = entries.length - shown;
  if (remaining > 0) {
    descLines.push(`_…and ${remaining} more_`);
  }

  const title = count === 1 ? "Bet Settled" : `${count} Bets Settled`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .setAuthor({
      name: user.displayName,
      iconURL: user.displayAvatarURL(),
    })
    .setDescription(descLines.join("\n\n"))
    .setFooter({ text: `Net ${sign}${netPts.toLocaleString()} pts` })
    .setTimestamp();

  if (thumbnailUrl) {
    embed.setThumbnail(thumbnailUrl);
  }

  return embed;
}

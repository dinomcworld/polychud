import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { getUserActiveBets } from "../services/betting.js";
import { ensureUser } from "../services/users.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

export const betCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("bet")
    .setDescription("Manage your bets")
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List your active bets"),
    ),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      await handleBetList(interaction);
    }
  },
};

async function handleBetList(
  interaction: import("discord.js").ChatInputCommandInteraction,
) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = await requireGuildId(interaction);
  if (!guildId) return;

  await ensureUser(interaction.user.id, guildId);
  const activeBets = await getUserActiveBets(interaction.user.id, guildId);

  if (activeBets.length === 0) {
    await interaction.editReply({
      content:
        "You have no active bets. Use `/market search` to find markets and place bets!",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Your Active Bets")
    .setColor(0x5865f2)
    .setTimestamp();

  const fields = activeBets.slice(0, 5).map((bet, _i) => {
    const question = bet.market
      ? bet.market.question.length > 50
        ? `${bet.market.question.slice(0, 47)}...`
        : bet.market.question
      : `Market #${bet.marketId}`;

    const eventSlug = bet.market?.event?.slug ?? null;
    const titleLine = eventSlug
      ? `[${question}](https://polymarket.com/event/${eventSlug})`
      : question;

    const entryPrice = parseFloat(bet.oddsAtBet);
    const entryPct = (entryPrice * 100).toFixed(1);

    const currentPrice = bet.market
      ? parseFloat(
          bet.outcome === "yes"
            ? bet.market.currentYesPrice || "0.5"
            : bet.market.currentNoPrice || "0.5",
        )
      : entryPrice;

    const currentPct = (currentPrice * 100).toFixed(1);
    const unrealizedPnL =
      Math.floor(bet.amount * (currentPrice / entryPrice)) - bet.amount;
    const pnlStr =
      unrealizedPnL >= 0 ? `+${unrealizedPnL}` : `${unrealizedPnL}`;

    return {
      name: `#${bet.id} — ${bet.outcome.toUpperCase()}`,
      value: [
        titleLine,
        `Stake: **${bet.amount.toLocaleString()}** pts`,
        `Entry: ${entryPct}% \u2192 Now: ${currentPct}%`,
        `Potential payout: **${bet.potentialPayout.toLocaleString()}** pts`,
        `P&L: **${pnlStr}** pts`,
      ].join("\n"),
    };
  });

  embed.addFields(fields);

  if (activeBets.length > 5) {
    embed.setFooter({
      text: `Showing 5 of ${activeBets.length} active bets`,
    });
  }

  // Add close buttons (coming soon placeholder for Phase 2)
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const closeButtons = activeBets
    .slice(0, 5)
    .map((bet) =>
      new ButtonBuilder()
        .setCustomId(`close_bet_${bet.id}`)
        .setLabel(`Close #${bet.id}`)
        .setStyle(ButtonStyle.Secondary),
    );

  // Discord allows max 5 buttons per row
  if (closeButtons.length > 0) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(closeButtons),
    );
  }

  await interaction.editReply({
    embeds: [embed],
    components: rows,
  });
}

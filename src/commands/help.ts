import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "./types.js";

export const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Learn about the bot and see available commands"),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle("Polychud — Virtual Prediction Market Betting")
      .setColor(0x5865f2)
      .setDescription(
        "Bet on real [Polymarket](https://polymarket.com) prediction markets using **virtual points**. " +
          "No real money involved — just bragging rights and leaderboard glory.",
      )
      .addFields(
        {
          name: "Getting Started",
          value:
            "Use any command and you'll be automatically registered with starting points. " +
            "Claim daily bonus points with `/daily` to build your bankroll.",
        },
        {
          name: "Commands",
          value: [
            "`/daily` — Claim your daily bonus points",
            "`/portfolio` — View your balance, stats, and active bets",
            "`/market search <query>` — Search Polymarket for markets",
            "`/market trending` — Top markets by volume",
            "`/market view <url|id>` — View a market by Polymarket URL or ID",
            "`/bet list` — View your active bets (with close buttons)",
            "`/leaderboard [sort]` — Top predictors (points/skill/average)",
            "`/help` — This message",
          ].join("\n"),
        },
        {
          name: "How Betting Works",
          value:
            "Markets have YES/NO outcomes priced 0-100%. " +
            "Lower prices = higher risk but bigger payouts. " +
            "When a market resolves, correct bets pay out and incorrect ones lose their stake. " +
            "You can also close bets early at the current market price.",
        },
        {
          name: "Prediction Score",
          value:
            "Your accumulated % tracks how good your predictions are overall. " +
            "Positive = you're beating the market. Negative = the market is beating you.",
        },
      )
      .setFooter({
        text: "Data from Polymarket • Virtual points only, not real money",
      });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};

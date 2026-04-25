import { SlashCommandBuilder } from "discord.js";
import { getUserActiveBets } from "../services/betting.js";
import { getUserStats } from "../services/users.js";
import { buildPortfolioView } from "../ui/portfolio.js";
import { requireGuildId } from "../utils/guards.js";
import type { Command } from "./types.js";

export const portfolioCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("portfolio")
    .setDescription("View a betting portfolio and stats")
    .addUserOption((opt) =>
      opt
        .setName("user")
        .setDescription("User to view (defaults to yourself)")
        .setRequired(false),
    ) as SlashCommandBuilder,

  async execute(interaction) {
    await interaction.deferReply();

    const guildId = await requireGuildId(interaction);
    if (!guildId) return;

    const target = interaction.options.getUser("user") ?? interaction.user;

    const stats = await getUserStats(target.id, guildId);
    const activeBets = await getUserActiveBets(target.id, guildId);

    const view = buildPortfolioView(target, stats, activeBets, 0, "active");
    await interaction.editReply(view);
  },
};

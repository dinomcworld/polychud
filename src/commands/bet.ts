import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { getUserActiveBets } from "../services/betting.js";
import { ensureUser } from "../services/users.js";
import { buildBetListView } from "../ui/betList.js";
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

  const view = buildBetListView(activeBets, 0, "active");
  await interaction.editReply(view);
}

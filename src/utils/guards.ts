import type { RepliableInteraction } from "discord.js";

export async function requireGuildId(
  interaction: RepliableInteraction,
): Promise<string | null> {
  if (interaction.guildId) return interaction.guildId;

  const content = "This command can only be used in a server.";
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, ephemeral: true });
  }
  return null;
}

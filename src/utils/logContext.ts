import type { Interaction } from "discord.js";
import { getCachedMarket } from "../services/polymarket.js";

/**
 * Human-readable actor prefix for interaction/command logs:
 *   user=alice(123) guild=My Server(456)
 * Falls back to "dm" when there is no guild. IDs are kept alongside the
 * names so logs stay greppable even after a rename.
 */
export function actorContext(interaction: Interaction): string {
  const user = `${interaction.user.username}(${interaction.user.id})`;
  const guild = interaction.guild
    ? `${interaction.guild.name}(${interaction.guildId})`
    : "dm";
  return `user=${user} guild=${guild}`;
}

/**
 * Best-effort readable market name for interaction logs. Scans the given
 * tokens (customId, select values, …) for a Polymarket condition id and, if
 * that market is in the cache, appends ` market="<question>"`. Returns an
 * empty string when nothing can be resolved — logging never blocks on this.
 */
export function marketContext(
  ...tokens: (string | undefined | null)[]
): string {
  for (const token of tokens) {
    if (!token) continue;
    const match = token.match(/0x[0-9a-f]{64}/i);
    if (!match) continue;
    const cached = getCachedMarket(match[0]);
    if (cached) return ` market="${cached.question}"`;
  }
  return "";
}

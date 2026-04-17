import { REST, Routes } from "discord.js";
import { betCommand } from "./commands/bet.js";
import { dailyCommand } from "./commands/daily.js";
import { helpCommand } from "./commands/help.js";
import { leaderboardCommand } from "./commands/leaderboard.js";
import { marketCommand } from "./commands/market.js";
import { portfolioCommand } from "./commands/portfolio.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";

const commands = [
  dailyCommand.data.toJSON(),
  portfolioCommand.data.toJSON(),
  helpCommand.data.toJSON(),
  marketCommand.data.toJSON(),
  betCommand.data.toJSON(),
  leaderboardCommand.data.toJSON(),
];

const rest = new REST().setToken(config.DISCORD_TOKEN);

const guildId = process.argv[2];

try {
  if (guildId) {
    logger.info(`Registering ${commands.length} commands to guild ${guildId}`);
    await rest.put(
      Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, guildId),
      { body: commands },
    );
  } else {
    logger.info(`Registering ${commands.length} commands globally`);
    await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), {
      body: commands,
    });
  }
  logger.info("Commands registered successfully.");
} catch (error) {
  logger.error("Failed to register commands:", error);
  process.exit(1);
}

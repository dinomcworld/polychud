import { ActivityType, Client, Collection, Events, GatewayIntentBits } from "discord.js";
import { config } from "./config.js";
import { logger } from "./utils/logger.js";
import { runMigrations } from "./db/migrate.js";

import type { Command } from "./commands/types.js";

// Import commands
import { dailyCommand } from "./commands/daily.js";
import { portfolioCommand } from "./commands/portfolio.js";
import { helpCommand } from "./commands/help.js";
import { marketCommand } from "./commands/market.js";
import { betCommand } from "./commands/bet.js";
import { leaderboardCommand } from "./commands/leaderboard.js";

// Import interaction handlers
import { handleButton } from "./interactions/buttons.js";
import { handleSelectMenu } from "./interactions/selects.js";
import { handleModal } from "./interactions/modals.js";

// Import jobs
import { startResolver, stopResolver } from "./jobs/resolver.js";
import { startPoller, stopPoller } from "./jobs/poller.js";

// Build command collection
const commands = new Collection<string, Command>();
const commandList: Command[] = [
  dailyCommand,
  portfolioCommand,
  helpCommand,
  marketCommand,
  betCommand,
  leaderboardCommand,
];
for (const cmd of commandList) {
  commands.set(cmd.data.name, cmd);
}

// Create client
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// Ready
client.once(Events.ClientReady, (readyClient) => {
  logger.info(`Bot online as ${readyClient.user.tag}`);

  readyClient.user.setPresence({
    activities: [{ name: "Nothing Ever Happens", type: ActivityType.Watching }],
    status: "online",
  });

  // Start background jobs after bot is ready
  startResolver();
  void startPoller();
});

// Interaction handler
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) {
        logger.warn(`Unknown command: ${interaction.commandName}`);
        return;
      }
      await command.execute(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (error) {
    logger.error("Interaction handler error:", error);
    const reply = {
      content: "Something went wrong. Please try again.",
      ephemeral: true,
    };
    try {
      if (interaction.isRepliable()) {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply);
        } else {
          await interaction.reply(reply);
        }
      }
    } catch {
      // Can't respond, interaction likely expired
    }
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down...`);

  // Stop background jobs
  stopResolver();
  stopPoller();

  // Destroy Discord client
  client.destroy();
  logger.info("Discord client destroyed");

  // Give in-flight DB operations a moment to complete
  await new Promise((r) => setTimeout(r, 2000));

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Run migrations then start
await runMigrations();
client.login(config.DISCORD_TOKEN);

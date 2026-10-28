import { pg } from "./setup.js";

/** Wipe every table between tests. Migrations stay applied. */
export async function resetDb() {
  await pg.exec(
    "TRUNCATE bets, guild_members, users, markets, events, guild_settings RESTART IDENTITY CASCADE",
  );
}

export { db } from "./setup.js";

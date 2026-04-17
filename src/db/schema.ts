import { relations } from "drizzle-orm";
import {
  boolean,
  decimal,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// ─── Events ───────────────────────────────────────────────────────────────────
export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    polymarketEventId: varchar("polymarket_event_id", { length: 255 })
      .notNull()
      .unique(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_events_status").on(table.status)],
);

// ─── Markets ──────────────────────────────────────────────────────────────────
export const markets = pgTable(
  "markets",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id").references(() => events.id),
    polymarketConditionId: varchar("polymarket_condition_id", { length: 255 })
      .notNull()
      .unique(),
    question: text("question").notNull(),
    yesTokenId: varchar("yes_token_id", { length: 255 }),
    noTokenId: varchar("no_token_id", { length: 255 }),
    currentYesPrice: decimal("current_yes_price", {
      precision: 5,
      scale: 4,
    }).default("0.5000"),
    currentNoPrice: decimal("current_no_price", {
      precision: 5,
      scale: 4,
    }).default("0.5000"),
    endDate: timestamp("end_date", { withTimezone: true }),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_markets_event_id").on(table.eventId),
    index("idx_markets_status").on(table.status),
    index("idx_markets_end_date").on(table.endDate),
  ],
);

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    discordId: varchar("discord_id", { length: 20 }).notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("idx_users_discord_id").on(table.discordId)],
);

// ─── Guild Members (per-guild user state) ────────────────────────────────────
export const guildMembers = pgTable(
  "guild_members",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    guildId: varchar("guild_id", { length: 20 }).notNull(),
    pointsBalance: integer("points_balance").notNull().default(1000),
    accumulatedPct: decimal("accumulated_pct", {
      precision: 10,
      scale: 4,
    })
      .notNull()
      .default("0.0000"),
    totalBetsSettled: integer("total_bets_settled").notNull().default(0),
    totalWon: integer("total_won").notNull().default(0),
    totalLost: integer("total_lost").notNull().default(0),
    lastDailyClaim: timestamp("last_daily_claim", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_guild_members_user_guild").on(table.userId, table.guildId),
    index("idx_guild_members_guild_id").on(table.guildId),
  ],
);

// ─── Bets ─────────────────────────────────────────────────────────────────────
export const bets = pgTable(
  "bets",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    marketId: integer("market_id")
      .notNull()
      .references(() => markets.id),
    eventId: integer("event_id").references(() => events.id),
    guildId: varchar("guild_id", { length: 20 }).notNull(),
    outcome: varchar("outcome", { length: 3 }).notNull(), // 'yes' or 'no'
    amount: integer("amount").notNull(),
    oddsAtBet: decimal("odds_at_bet", { precision: 5, scale: 4 }).notNull(),
    potentialPayout: integer("potential_payout").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    actualPayout: integer("actual_payout"),
    closedEarly: boolean("closed_early").notNull().default(false),
    closePrice: decimal("close_price", { precision: 5, scale: 4 }),
    placedAt: timestamp("placed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_bets_user_id").on(table.userId),
    index("idx_bets_market_id").on(table.marketId),
    index("idx_bets_status").on(table.status),
    index("idx_bets_guild_id").on(table.guildId),
    index("idx_bets_user_status").on(table.userId, table.status),
  ],
);

// ─── Guild Settings ───────────────────────────────────────────────────────────
export const guildSettings = pgTable("guild_settings", {
  id: serial("id").primaryKey(),
  guildId: varchar("guild_id", { length: 20 }).notNull().unique(),
  startingPoints: integer("starting_points").notNull().default(1000),
  maxBet: integer("max_bet").notNull().default(500),
  minBet: integer("min_bet").notNull().default(10),
  dailyBonus: integer("daily_bonus").notNull().default(100),
  bettingChannelId: varchar("betting_channel_id", { length: 20 }),
  notificationsEnabled: boolean("notifications_enabled")
    .notNull()
    .default(true),
  leaderboardDefaultSort: varchar("leaderboard_default_sort", { length: 20 })
    .notNull()
    .default("points"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ─── Relations ────────────────────────────────────────────────────────────────

export const eventsRelations = relations(events, ({ many }) => ({
  markets: many(markets),
}));

export const marketsRelations = relations(markets, ({ one, many }) => ({
  event: one(events, {
    fields: [markets.eventId],
    references: [events.id],
  }),
  bets: many(bets),
}));

export const usersRelations = relations(users, ({ many }) => ({
  bets: many(bets),
  guildMembers: many(guildMembers),
}));

export const guildMembersRelations = relations(guildMembers, ({ one }) => ({
  user: one(users, {
    fields: [guildMembers.userId],
    references: [users.id],
  }),
}));

export const betsRelations = relations(bets, ({ one }) => ({
  user: one(users, {
    fields: [bets.userId],
    references: [users.id],
  }),
  market: one(markets, {
    fields: [bets.marketId],
    references: [markets.id],
  }),
  event: one(events, {
    fields: [bets.eventId],
    references: [events.id],
  }),
}));

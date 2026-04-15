CREATE TABLE "bets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"market_id" integer NOT NULL,
	"event_id" integer,
	"guild_id" varchar(20) NOT NULL,
	"outcome" varchar(3) NOT NULL,
	"amount" integer NOT NULL,
	"odds_at_bet" numeric(5, 4) NOT NULL,
	"potential_payout" integer NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"actual_payout" integer,
	"closed_early" boolean DEFAULT false NOT NULL,
	"close_price" numeric(5, 4),
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"polymarket_event_id" varchar(255) NOT NULL,
	"title" text NOT NULL,
	"slug" varchar(512),
	"description" text,
	"image_url" text,
	"end_date" timestamp with time zone,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"neg_risk" boolean DEFAULT false NOT NULL,
	"market_count" integer DEFAULT 0 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_polymarket_event_id_unique" UNIQUE("polymarket_event_id")
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(20) NOT NULL,
	"starting_points" integer DEFAULT 1000 NOT NULL,
	"max_bet" integer DEFAULT 500 NOT NULL,
	"min_bet" integer DEFAULT 10 NOT NULL,
	"daily_bonus" integer DEFAULT 100 NOT NULL,
	"betting_channel_id" varchar(20),
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"leaderboard_default_sort" varchar(20) DEFAULT 'points' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_settings_guild_id_unique" UNIQUE("guild_id")
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer,
	"polymarket_condition_id" varchar(255) NOT NULL,
	"question" text NOT NULL,
	"outcome_label" varchar(255),
	"slug" varchar(512),
	"yes_token_id" varchar(255),
	"no_token_id" varchar(255),
	"current_yes_price" numeric(5, 4) DEFAULT '0.5000',
	"current_no_price" numeric(5, 4) DEFAULT '0.5000',
	"end_date" timestamp with time zone,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"resolved_outcome" varchar(10),
	"volume_24h" numeric(18, 2),
	"one_hour_price_change" numeric(10, 6),
	"one_day_price_change" numeric(10, 6),
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_polymarket_condition_id_unique" UNIQUE("polymarket_condition_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"discord_id" varchar(20) NOT NULL,
	"points_balance" integer DEFAULT 1000 NOT NULL,
	"accumulated_pct" numeric(10, 4) DEFAULT '0.0000' NOT NULL,
	"total_bets_settled" integer DEFAULT 0 NOT NULL,
	"total_won" integer DEFAULT 0 NOT NULL,
	"total_lost" integer DEFAULT 0 NOT NULL,
	"last_daily_claim" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id")
);
--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bets" ADD CONSTRAINT "bets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bets_user_id" ON "bets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_bets_market_id" ON "bets" USING btree ("market_id");--> statement-breakpoint
CREATE INDEX "idx_bets_status" ON "bets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_bets_guild_id" ON "bets" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "idx_bets_user_status" ON "bets" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_events_status" ON "events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_events_end_date" ON "events" USING btree ("end_date");--> statement-breakpoint
CREATE INDEX "idx_markets_event_id" ON "markets" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_markets_status" ON "markets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_markets_end_date" ON "markets" USING btree ("end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_discord_id" ON "users" USING btree ("discord_id");
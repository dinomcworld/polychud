ALTER TABLE "bets" ALTER COLUMN "event_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "markets" ALTER COLUMN "event_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "slug" varchar(255);
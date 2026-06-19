/**
 * Operator script: cancel an incorrectly-resolved (or to-be-voided) market.
 *
 * Refunds every stake, claws back any payouts already credited, reverses the
 * stat counters, marks the market cancelled, and stores the reason so affected
 * players see a REFUNDED card (with the reason) on their next bot interaction.
 *
 * Usage (local dev):
 *   bun src/scripts/cancelMarket.ts <market> <reason...> [--confirm]
 *     <market>  a numeric market id (e.g. 57), a 0x… Polymarket condition id,
 *               or a Polymarket event URL/slug (lists that event's markets to
 *               pick from).
 *     <reason>  free text shown to players; required to actually execute.
 *     --confirm without it, the script only previews what it would do.
 *
 * Usage (production / docker — this file is bundled to dist/scripts/cancelMarket.js):
 *   docker compose -f docker-compose.prod.yml run --rm bot \
 *     bun dist/scripts/cancelMarket.js <market> "<reason>" --confirm
 *
 * Examples:
 *   bun src/scripts/cancelMarket.ts 57 "Polymarket misresolved" --confirm
 *   bun src/scripts/cancelMarket.ts 0xabc123… "Settled YES but outcome was NO"
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { bets, events, markets } from "../db/schema.js";
import { cancelMarket } from "../services/betting.js";

function usage(msg?: string): never {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(
    'Usage: bun src/scripts/cancelMarket.ts <market id | 0x… condition id | event url> "<reason>" [--confirm]',
  );
  process.exit(1);
}

/** Resolve the <market> argument to a single markets row, or print candidates. */
async function resolveMarket(identifier: string) {
  if (/^\d+$/.test(identifier)) {
    return db.query.markets.findFirst({
      where: eq(markets.id, Number(identifier)),
    });
  }

  if (/^0x[0-9a-f]+$/i.test(identifier)) {
    return db.query.markets.findFirst({
      where: eq(markets.polymarketConditionId, identifier),
    });
  }

  // Treat as an event URL or bare slug — an event can hold several markets, so
  // list them and let the operator re-run with the exact id.
  const slug = identifier.match(/\/event\/([^/?#]+)/)?.[1] ?? identifier;
  const event = await db.query.events.findFirst({
    where: eq(events.slug, slug),
    with: { markets: true },
  });

  if (!event || event.markets.length === 0) {
    usage(`No market found for "${identifier}".`);
  }

  console.log(`Event "${slug}" has ${event.markets.length} market(s):\n`);
  for (const m of event.markets) {
    console.log(
      `  id=${m.id}  [${m.status}]  ${m.polymarketConditionId}\n    ${m.question}`,
    );
  }
  console.log("\nRe-run with a specific market id or condition id.");
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const confirm = argv.includes("--confirm");
  const positional = argv.filter((a) => a !== "--confirm");

  const identifier = positional[0];
  const reason = positional.slice(1).join(" ").trim();
  if (!identifier) usage("Missing <market> argument.");

  const market = await resolveMarket(identifier);
  if (!market) usage(`No market found for "${identifier}".`);

  // Count what would be affected (mirrors cancelMarket's status filter).
  const affected = await db.query.bets.findMany({
    where: and(
      eq(bets.marketId, market.id),
      inArray(bets.status, ["pending", "won", "lost"]),
    ),
  });
  const users = new Set(affected.map((b) => b.userId)).size;
  const stake = affected.reduce((sum, b) => sum + b.amount, 0);

  console.log(`Market #${market.id} [${market.status}]: ${market.question}`);
  console.log(`Condition id: ${market.polymarketConditionId}`);
  console.log(
    `Would revert ${affected.length} bet(s) across ${users} user(s), refunding ${stake.toLocaleString()} pts staked.`,
  );

  if (market.status === "cancelled") {
    console.log("\nMarket is already cancelled — nothing to do.");
    process.exit(0);
  }

  if (!reason) usage("Missing <reason> — required to cancel a market.");

  if (!confirm) {
    console.log(`\nReason: ${reason}`);
    console.log("\nDry run. Re-run with --confirm to apply.");
    process.exit(0);
  }

  console.log(`\nReason: ${reason}\nApplying…`);
  const result = await cancelMarket(market.id, reason);
  console.log(
    `Done. Reverted ${result.reverted} bet(s), refunded ${result.refundedPts.toLocaleString()} pts across ${result.users} user(s). Market #${market.id} → cancelled.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

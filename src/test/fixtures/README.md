# Fixtures

Verbatim responses captured from the live Polymarket APIs on 2026-09-07, trimmed
for size (fewer events, shorter price histories) but never reshaped — the field
names, string-encoded numbers and JSON-in-string arrays are exactly what
`gamma-api.polymarket.com` and `clob.polymarket.com` returned.

| File                                 | Endpoint                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `search-fed-decision.json`           | `GET /public-search?q=fed decision` (first 2 events)                                                                             |
| `event-by-slug.json`                 | `GET /events?slug=fed-decision-in-september-762`                                                                                 |
| `event-by-id.json`                   | `GET /events?id=481717`                                                                                                          |
| `events-trending.json`               | `GET /events?order=volume24hr&limit=3` (4 markets each)                                                                          |
| `events-tag-snapshot.json`           | `GET /events?order=volume24hr&limit=20`, reduced to `id`/`slug`/`tags`                                                           |
| `tags.json`                          | `GET /tags?order=id&ascending=true` (first 40)                                                                                   |
| `market-by-id.json`                  | `GET /markets?id=2252242`                                                                                                        |
| `market-by-condition-id.json`        | `GET /markets?condition_ids=0x5e46…`                                                                                             |
| `market-closed-by-condition-id.json` | `GET /markets?condition_ids=0x6a36…&closed=true` — a resolved market, which the same query without `closed=true` returns as `[]` |
| `event-with-placeholders.json`       | `GET /events?slug=which-party-will-win-the-house-in-2026` — 2 traded markets plus 7 untraded neg-risk placeholder slots          |
| `clob-prices.json`                   | `POST /prices` for both tokens of market 2252242                                                                                 |
| `clob-midpoint.json`                 | `GET /midpoint?token_id=97186…`                                                                                                  |
| `clob-prices-history.json`           | `GET /prices-history?market=97186…&interval=1w` (first 50 points)                                                                |

Captured on 2026-11-09 for the short-window gate:

| File                                    | Endpoint                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------- |
| `event-updown-5m.json`                  | `GET /events?slug=btc-updown-5m-1794237900` — a live 5-minute series event |
| `market-updown-5m-by-condition-id.json` | `GET /markets?condition_ids=0x9156…` — the same market via `/markets`      |
| `event-updown-daily.json`               | `GET /events?slug=bitcoin-up-or-down-on-november-9-2026` — a daily series  |

Two fixtures are derived rather than captured, each a real payload with a single
field edited to reproduce a condition not present in the live snapshot:

- `event-all-placeholders.json` — `event-with-placeholders.json` with its traded
  markets removed, for the "every sub-market is a placeholder" fallback.
- `market-unencoded-image.json` — `market-by-id.json` with the raw-space S3
  image URL Polymarket has served for repetitive sports markets, plus a
  non-URL `icon`.

# Polychud

Discord bot for virtual betting on Polymarket prediction markets. No real money — just points.

## Setup

```bash
cp .env.example .env
# Fill in DISCORD_TOKEN and DISCORD_CLIENT_ID
```

### Docker (recommended)

```bash
docker compose up -d --build
```

### Local

```bash
bun install
bun run db:generate
bun run db:migrate
bun run deploy-commands <guild-id>
bun run dev
```

## Commands

| Command | Description |
|---|---|
| `/market search <query>` | Search Polymarket events |
| `/market trending` | Show trending markets by volume |
| `/market view <url\|id>` | View a market by Polymarket URL or ID |
| `/bet list` | List your active bets |
| `/portfolio` | View your points balance and stats |
| `/daily` | Claim daily bonus points |
| `/leaderboard` | Server leaderboard |
| `/help` | Show help |

## Stack

- Bun / TypeScript
- Discord.js
- PostgreSQL + Drizzle ORM
- Polymarket Gamma & CLOB APIs

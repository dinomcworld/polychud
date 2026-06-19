# ─── Stage 1: Install dependencies ─────────────────────────────────────────────
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN SKIP_INSTALL_SIMPLE_GIT_HOOKS=1 bun ci
# ─── Stage 2: Build with Bun ───────────────────────────────────────────────────
FROM deps AS builder
COPY tsconfig.json ./
COPY src/ ./src/
RUN bun build src/index.ts src/deploy-commands.ts src/scripts/cancelMarket.ts --target=bun --outdir=dist --minify --sourcemap=linked --production

# ─── Stage 3: Production image ────────────────────────────────────────────────
FROM oven/bun:1-alpine AS production
WORKDIR /app

# resvg-js (used by the chart renderer)
RUN apk add --no-cache ttf-dejavu

RUN addgroup -S bot && adduser -S bot -G bot

COPY --from=builder /app/dist ./dist
COPY drizzle ./drizzle

USER bot
ENV NODE_ENV=production

CMD ["bun", "dist/index.js"]

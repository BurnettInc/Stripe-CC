# Single-service production image for CollectionsCopilot (backend + marketing site).
#
# The ENTIRE product now runs as ONE Railway service. Railway does not
# auto-detect Bun projects — Railpack has no Bun provider — so this explicit
# Dockerfile at the repo root is Railway's documented path (see
# https://docs.railway.com/guides/bun). Set the service's "Root Directory" to
# the repo root; Railway auto-detects this Dockerfile.
#
# What the image contains:
#   1. The TanStack Start marketing site (site/), built to dist/server/server.js
#      (portable SSR fetch handler) + dist/client (static assets).
#   2. The Bun backend (app/), which serves its own API/webhook/OAuth/dashboard
#      routes AND falls back to the built site for every other path (landing
#      page at "/", /support, /privacy, /terms, /about, static assets).
FROM oven/bun:1

# CA certificates: Stripe API calls (and AI draft calls) go over HTTPS; make
# sure real CAs are present in the image.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Marketing site: install full deps (build needs devDependencies) and build ──
COPY site/package.json site/bun.lock ./site/
RUN cd site && bun install --frozen-lockfile
# The site build resolves the LIVE dashboard file (site/src/routes/demo.tsx
# imports ../../../app/src/ui/dashboard.html?raw so /demo is a pixel-exact
# replica) — app/ must be in the image before `cd site && bun run build`.
COPY app/package.json app/bun.lock ./app/
RUN cd app && bun install --frozen-lockfile --production
COPY app/ ./app/
COPY site/ ./site/
RUN cd site && bun run build

# The backend reads PORT from the environment (src/index.ts); 3002 is the
# local-dev default. DB_PATH (Railway volume mount, e.g. /data/app.db) is read
# by src/db.ts.
EXPOSE 3002

# Start the backend; it serves the site's SSR handler + static assets for
# non-API paths (the site handler import path resolves to /app/site/dist/...).
CMD ["sh", "-c", "cd app && bun run start"]

# Railway does not auto-detect Bun projects — Railpack has no Bun provider, so
# Railway's documented path for Bun apps is an explicit Dockerfile (see
# https://docs.railway.com/guides/bun). The build context is the app/
# directory (set as the service "Root Directory" in Railway).
FROM oven/bun:1-alpine

# CA certificates: Stripe API calls (and AI draft calls) go over HTTPS; the
# alpine base has a minimal cert store, so make sure real CAs are present.
RUN apk add --no-cache ca-certificates

WORKDIR /app

# Install production dependencies first — keeps the layer cached across builds.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy the rest of the app source (see .dockerignore for exclusions).
COPY . ./

# The app reads PORT from the environment (src/index.ts) and DB_PATH for the
# SQLite file (src/db.ts) — both are set via Railway service variables.
# railway.json deploy.startCommand mirrors this command.
CMD ["bun", "run", "src/index.ts"]

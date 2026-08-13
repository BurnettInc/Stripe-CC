# Deploying the CollectionsCopilot backend to Railway

This is the owner's setup checklist for running the backend on Railway.
It was verified against Railway's current documentation (Railpack builder,
config-as-code, volumes) and the app's actual code. The app's own config
(`app/railway.json`) and Dockerfile ship with the repo — most of this doc is
one-time dashboard setup.

> **Why a Dockerfile?** Railway's current builder (Railpack) does **not**
> auto-detect Bun projects — Railway's official Bun guide says to add a
> Dockerfile (`https://docs.railway.com/guides/bun`). The repo ships a minimal
> `app/Dockerfile` (`oven/bun:1-alpine`) for exactly this reason; `railway.json`
> pins `build.builder = DOCKERFILE` and the start command.

---

## 1. Railway project setup

1. Sign in to [Railway](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Pick **BurnettInc/Stripe-CC**.
3. After the service is created, open the service → **Settings** tab and set:
   - **Root Directory**: `app`
   - **Start Command**: `bun run src/index.ts` (already set by `app/railway.json`; leave it)
4. Open **Settings → Networking** → **Generate Domain** to get your public URL
   (e.g. `https://your-app.up.railway.app`). Save it — you need it for `BASE_URL`
   below and for the Stripe dashboard URLs in steps 4–5.

Notes:
- Railway reads `app/railway.json` automatically (config files are addressed by
  their repo-root path, even with a root directory set). It sets the builder to
  Dockerfile, the start command, a `/health` healthcheck, and an on-failure
  restart policy — no dashboard action needed for those.
- The repo must contain `app/bun.lock` (committed as of the Railway-deploy PR)
  because the Dockerfile installs with `bun install --frozen-lockfile`.

## 2. Volume — REQUIRED (merchant data persistence)

Railway's filesystem is **ephemeral**: everything written to it is wiped on
every redeploy. The app stores all merchant data in a SQLite database, so a
volume is **mandatory** — without it, every redeploy silently wipes invoices,
tasks, subscriptions, and OAuth tokens.

1. Open the service → **Volumes** → **New Volume**.
2. Mount path: **`/data`**
3. Size: 1 GB is plenty for SQLite (Free plan max is 0.5 GB).
4. Set the env var `DB_PATH=/data/app.db` (step 3) so the app writes the DB onto
   the volume. The SQLite WAL files (`app.db-wal`, `app.db-shm`) live next to
   the DB on the same volume automatically.

> ⚠️ Do not deploy merchant-facing traffic until the volume is attached and
> `DB_PATH` is set. Create the volume **before** the first real deploy so the
> database is born on the volume, not in the ephemeral filesystem.

Railway caveats that matter here: one volume per service; deployments with a
volume attached take a short downtime window on redeploy; **do not scale
replicas** (volumes can't be used with replicas, and SQLite is single-writer
anyway — keep 1 instance).

## 3. Environment variables

Set these in the service → **Variables** tab. `NODE_ENV=production`, `STRIPE_WEBHOOK_SECRET`,
and `FROM_EMAIL` are boot-time requirements — the app refuses to start without them in
production.

| Variable | Required | What it's for |
|---|---|---|
| `BASE_URL` | ✅ | The Railway public URL, **no trailing slash**: `https://your-app.up.railway.app`. Drives Stripe Connect OAuth redirect/return URLs, the Stripe Apps marketplace install URL, billing checkout return URLs, and email unsubscribe links (all built as `${BASE_URL}/...`). |
| `STRIPE_SECRET_KEY` | ✅ | Owner's Stripe secret key — test-mode key (`sk_test_…`) while testing, live key (`sk_live_…`) when ready. Webhooks & billing fail without it. |
| `STRIPE_CLIENT_ID` | ✅ (for Stripe App install) — **legacy default** | The Stripe Apps application client id (`ca_…`) from the Stripe dashboard (Apps → your app → API authentication). Used as the **fallback** client id for BOTH test and live marketplace authorize URLs when the mode-specific `STRIPE_APP_TEST_CLIENT_ID` / `STRIPE_APP_LIVE_CLIENT_ID` are unset (backward compatible — this is the live/default client id, so existing single-env setups keep working). Without any client id the install page shows a clear "not configured" notice and never crashes. |
| `STRIPE_APP_TEST_CLIENT_ID` | ✅ (for test installs) | The app client id (`ca_…`) for **test-mode** marketplace install links (test and live OAuth install links carry DIFFERENT client ids — see the External test tab in the Stripe dashboard). Overrides `STRIPE_CLIENT_ID` when building the test-mode authorize URL (`/oauth/install/start?link=test`). Falls back to `STRIPE_CLIENT_ID` when unset. |
| `STRIPE_APP_LIVE_CLIENT_ID` | ✅ (for live installs) | The app client id (`ca_…`) for **live-mode** marketplace install links. Overrides `STRIPE_CLIENT_ID` when building the live-mode authorize URL (`/oauth/install/start?link=live`). Falls back to `STRIPE_CLIENT_ID` when unset. |
| `STRIPE_APP_TEST_KEY` | ✅ (for Stripe App install) | The app **developer API key** for **test-mode links** (Apps → your app → API authentication → developer keys). Used as the Basic-auth credential when exchanging the one-time authorization code and when refreshing access tokens for test-mode installs. |
| `STRIPE_APP_LIVE_KEY` | ✅ (for live installs) | The app **developer API key** for **live-mode links**. Same role as `STRIPE_APP_TEST_KEY` but for live installs; without it live-mode links fail with a clear error page (test-mode installs are unaffected). |
| `STRIPE_WEBHOOK_SECRET` | ✅ | Signing secret (`whsec_…`) of the **/webhook** endpoint from Stripe (step 4). **Mandatory** — the app exits at boot without it when `NODE_ENV=production` (webhook signature verification is a hard requirement, not optional). |
| `STRIPE_BILLING_WEBHOOK_SECRET` | ✅ | Signing secret of the **/billing** endpoint (step 4). (Code falls back to `STRIPE_WEBHOOK_SECRET` if unset, but set the real one.) |
| `TOKEN_ENCRYPTION_KEY` | ✅ | Stable random value — encrypts session and OAuth tokens at rest. Generate once with `openssl rand -hex 32`. **Changing it logs every merchant out and invalidates stored Stripe tokens — never rotate casually.** |
| `NODE_ENV` | ✅ | `production` (engages the boot guard and production behavior). |
| `DB_PATH` | ✅ | `/data/app.db` — where SQLite lives (must match the volume mount path from step 2). |
| `BUSINESS_ADDRESS` | ✅ (by law) | Physical mailing address for the CAN-SPAM footer on every outgoing email. |
| `FROM_EMAIL` | ✅ | Sender address for reminders and summaries — must be on a **Resend-verified domain** (e.g. `reminders@mail.getcollectionscopilot.com`). **FATAL if missing** — the app exits at boot without it when `NODE_ENV=production` (the code-level fallback `noreply@stripecollectionscopilot.com` is unregistered, so Resend would reject every send). |
| `SENDGRID_API_KEY` **or** `RESEND_API_KEY` | ✅ (to send) | Pick **one** email provider — the code supports both natively. With neither set, the app runs in **log-only mode** (emails are logged, never delivered). Do not launch without one. |
| `OPENAI_API_KEY` | ✅ (for AI drafts) | Powers the AI drafter (product default model `gpt-4o-mini`). Without it, drafting falls back to templates. |
| `PORT` | ❌ do **not** set | Railway injects `PORT` automatically; the app now honors it (`Number(process.env.PORT) || 3002`). Setting it manually can collide with Railway's value. |
| `LLM_API_BASE` / `LLM_MODEL` | optional | Override the OpenAI base URL / model for the drafter. |
| `RAILWAY_RUN_UID` | optional | Only if the volume reports permission errors (the Dockerfile runs as root, so usually unnecessary). |

## 4. Stripe Dashboard — webhook endpoints

In the Stripe Dashboard (**Developers → Webhooks → Add endpoint**), create
**both** endpoints. Do this in **test mode** first; repeat with the same paths
in **live mode** once you switch keys. Use the full Railway URL for the paths:

**Endpoint 1 — invoice events**
- URL: `https://<railway-url>/webhook`
- Events: `invoice.overdue`, `invoice.payment_failed`, `invoice.paid`, `invoice.updated`
- Copy the signing secret (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.

**Endpoint 2 — subscription (billing) events**
- URL: `https://<railway-url>/billing`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`
- Copy the signing secret → `STRIPE_BILLING_WEBHOOK_SECRET`.

Tip: while testing locally, `stripe listen --forward-to localhost:3002/webhook`
works unchanged — the boot guard only trips in production.

## 5. Stripe Connect OAuth — redirect URI

For merchant Stripe-account connection to work, add the OAuth redirect URI in
**Stripe Dashboard → Settings → Connect → OAuth settings**:

- **Redirect URI**: `https://<railway-url>/oauth/callback`

The app also serves `/stripe/oauth/callback` and `/api/oauth/callback` as
aliases; the account-link return URL is built from `BASE_URL` automatically, so
keep `BASE_URL` free of a trailing slash.

## 5b. Stripe Apps marketplace install (OAuth v2) — install URL + developer keys
The Stripe App Marketplace installs CollectionsCopilot through Stripe's **OAuth
v2** flow (parallel to — and independent from — the web Connect flow above).
The URL you give Stripe as the **marketplace install URL** is:

- `https://<railway-url>/oauth/install` (production: `https://stripe-cc-production.up.railway.app/oauth/install`)

What the flow does (all backend; no stripe-app changes needed — the manifest
already declares `"stripe_api_access_type": "oauth"` with
`allowed_redirect_uris: ["https://<railway-url>/oauth/callback"]`):

1. The install URL renders a branded page with a **"Connect with Stripe"**
   button per configured mode (test/live) — the page the reviewer required,
   with clear instructions and OAuth install links.
2. The button → `GET /oauth/install/start?link=test|live` → the backend mints a
   CSRF-safe `state` (stored one-time, 30-min TTL, link type encoded inside)
   and 302s to `https://marketplace.stripe.com/oauth/v2/authorize?client_id=…&redirect_uri=…&state=…`.
3. After the user authorizes, Stripe redirects to `GET /oauth/callback?code=…&state=…`
   (the same path the web flow uses — the backend branches on the `code` param).
   The backend verifies+consumes the state, exchanges the one-time code at
   `POST https://api.stripe.com/v1/oauth/token` (Basic auth with the developer
   key matching the link type), stores `{stripe_user_id, access_token,
   refresh_token, livemode, expires_at}` in the `oauth_tokens` table
   (encrypted at rest with `TOKEN_ENCRYPTION_KEY`), creates/finds the merchant,
   mirrors into `stripe_connections`, mints a session and bounces through the
   www-host `/oauth/session` handoff → the user lands logged-in on the
   dashboard. Access tokens expire ~1h; refresh tokens expire ~1yr and roll on
   every exchange (`refreshAppAccessToken()` in
   `src/routes/oauth-app-install.ts`).

Required env for the install flow (see the table above): `STRIPE_APP_TEST_CLIENT_ID`
and `STRIPE_APP_LIVE_CLIENT_ID` (per-mode app client ids `ca_…`; `STRIPE_CLIENT_ID`
is the legacy default fallback), and `STRIPE_APP_TEST_KEY` / `STRIPE_APP_LIVE_KEY`
(app developer keys). Developer keys and the per-mode OAuth install links live
in the Stripe dashboard under **Apps → your app → API authentication** (test and
live links carry different client ids). When a client id or key is missing the
matching mode's link/button is hidden or fails with a clear error page —
test-mode installs don't need the live vars and vice versa.

## 6. First boot — database initialization (no manual step)

Nothing to do here — this is just to be explicit about how it works:

- `getDb()` (in `src/db.ts`) creates the SQLite file at `DB_PATH` if it doesn't
  exist (`{ create: true }`), then **applies `schema.sql` on every boot**
  (all `CREATE TABLE IF NOT EXISTS` — idempotent), then runs any not-yet-applied
  files in `app/migrations/` (tracked in the `schema_migrations` table, so each
  runs at most once).
- Net effect: the **first boot fully initializes the database** on the volume,
  and every later boot is a no-op. No separate init/migrate command exists or is
  needed.
- If you ever need a pristine database on Railway, delete the volume (or the
  `app.db*` files in it via `railway volume browse`) and redeploy — the app will
  recreate an empty schema on next boot. Back up the volume first (Railway
  supports volume backups).

## 7. Health check after deploy

Railway's deployment healthcheck (set in `railway.json`) pings `/health`, which
needs no auth or env vars:

```bash
curl https://<railway-url>/health
# → {"status":"ok","uptime":…,"uptimeFormatted":"0h 0m 5s","startedAt":"…"}
```

If the deploy shows unhealthy, check **Deployments → logs**:
- `FATAL: STRIPE_WEBHOOK_SECRET is not set…` → set the variable (step 3) and redeploy.
- `FATAL: FROM_EMAIL is not set…` → set `FROM_EMAIL` to an address on a Resend-verified domain (step 3) and redeploy.
- `Error: Cannot find module …` / bun errors → confirm the root directory is `app` and the Dockerfile/railway.json are present (step 1).
- Volume permission errors on `app.db` → set `RAILWAY_RUN_UID=0` and redeploy.

## Updating the deployed app

Railway autodeploys from GitHub. Merge to `main` (or push to the linked branch)
→ Railway builds the Dockerfile and redeploys. With the volume attached there is
a short downtime window during redeploy (expected — see step 2 caveats).

## Files that make this work (all in `app/`)

- `railway.json` — builder=Dockerfile, start command, `/health` healthcheck, restart policy
- `Dockerfile` — `oven/bun:1-alpine`, frozen-lockfile install, CA certs
- `.dockerignore` — keeps `node_modules`, DB files, and env files out of the image
- `src/index.ts` — `PORT` now honors `process.env.PORT` (Railway's dynamic port); boot guard exits unless `FROM_EMAIL` is set outside local dev
- `src/db.ts` — `DB_PATH` support (default unchanged: `app.db` in the app dir)
- `src/pipeline/canspam.ts` — unsubscribe links now derive from `BASE_URL`
- `bun.lock` — committed so the Dockerfile's frozen install is reproducible

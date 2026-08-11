# DEPLOY.md — CollectionsCopilot production launch checklist

**Status (2026-08-11):** backend is feature-complete for the homepage promise; production
(`https://stripe-cc-production.up.railway.app`) is healthy; email delivery is configured (Resend,
domain verified); support ops APIs are live. This file is the launch checklist the team owes the
owner — what's verified live, and the remaining owner steps in order.

## 🚂 Railway config — SINGLE SERVICE (replaces the split site/backend hosting)

**Change (2026-08-11, PR #30):** the ENTIRE product now runs as ONE Railway service. The repo-root
`Dockerfile` builds the TanStack Start site (`site/`) and then runs the Bun backend (`app/`), which
serves the site's built assets + SSR handler for non-API paths. The old separate hosting of the
marketing site is retired — the site no longer needs a second deployment target.

### Railway service settings to change (one-time, by the lead)
- **Root Directory: repo root** (was `app/`) — Railway auto-detects the root `Dockerfile`.
  (`railway.json` at the repo root sets the Dockerfile builder + `/health` healthcheck; there is no
  startCommand there, so the Dockerfile's `CMD` runs the backend.)
- All existing service variables stay unchanged: `PORT` (injected), `DB_PATH=/data/app.db`
  (volume `stripe-cc-volume` @ `/data`), Stripe keys/webhook secrets, `RESEND_API_KEY`,
  `FROM_EMAIL`, `BASE_URL`, `SUPPORT_API_TOKEN`, `TOKEN_ENCRYPTION_KEY`, optional `OPENAI_API_KEY`.
  `APP_API_URL` is NO LONGER required — see below.

### URL layout after this change (on the Railway domain, e.g. https://stripe-cc-production.up.railway.app)
- `/` — **landing page** (marketing site SSR: hero, pricing, /support, /privacy, /terms, /about).
  "Stripe users should land on the landing page, not the dashboard" (owner direction) — satisfied.
- `/dashboard` — **the app dashboard** (moved from `/`). Its root-absolute API calls
  (`/tasks`, `/settings`, `/stripe/connect`, ...) are unaffected by the move.
- All API/webhook/OAuth routes keep their exact paths and CORS: `/api/*`, `/health`, `/stats`,
  `/tasks`, `/settings`, `/invoices/*`, `/subscription`, `/aggregate`, `/stripe/connect`,
  `/stripe/connection`, `/stripe/oauth/callback`, `/oauth/callback`, `/billing` + `/billing/*`,
  `/webhook`, `/summary`, `/summary/send`, `/support/lookup`, `/support/log`, `/unsubscribe`.
  Backend routes always match before the site fallback (e.g. `/support` is a site page while
  `/support/lookup` is a backend API).
- Post-Stripe redirects (OAuth success/error, billing checkout/portal returns) now land on
  `/dashboard?connected=true`, `/dashboard?error=...`, etc.

### APP_API_URL default behavior
The site's checkout server fn now defaults to `APP_API_URL || BASE_URL || http://localhost:3001`.
On Railway, `BASE_URL` is already set, so the checkout call goes **same-origin** (the backend is
the same service) — no `APP_API_URL` env var needed. Set `APP_API_URL` only if the backend were
ever hosted separately again.

### Deploy + verify steps
1. In the Railway dashboard, set the service **Root Directory** to the repo root (leave
   variables untouched) and deploy the merged `main`.
2. Verify: `GET /` returns the landing page (200, HTML); `GET /dashboard` returns the dashboard
   (200, HTML); `GET /health` 200; `POST /webhook` still verifies signatures (Stripe dashboard
   shows the endpoint unchanged); OAuth flow lands on `/dashboard?connected=true` after
   onboarding; checkout success/cancel land on `/dashboard?...`.
3. If the site is ever served from the Stripe App domain or another host, point that host's
   root at the Railway domain — no second deployment exists anymore.

**Note for the Stripe App:** the app surface (`/stripe/connect`, `/stripe/oauth/callback`,
`/oauth/callback`, `/webhook`, `/billing/*`, `/api/*`) is unchanged — same paths, same CORS
headers (`dashboard.stripe.com` is in `allowedOrigins`).

## ✅ Verified live (no action needed)
- **Backend**: `/health` 200; webhook handling (overdue detection, dispute → pause+notify,
  refund → stop, deauth → stop+disconnect, paid → notify); 3-stage escalation; Trust Mode
  (Draft/Semi/Full + pause); CAN-SPAM footer + opt-out; merchant settings (sender branding,
  custom timing, late-fee automation); six critical gate fixes.
- **Email delivery**: `RESEND_API_KEY`, `FROM_EMAIL=reminders@mail.getcollectionscopilot.com`,
  `BASE_URL` set on Railway; `mail.getcollectionscopilot.com` verified (SPF/DKIM/DMARC);
  FROM_EMAIL boot guard live.
- **Support ops**: `GET /support/lookup?email=` + `GET|POST /support/log` live, Bearer-gated by
  `SUPPORT_API_TOKEN` (token stored at `/home/team/shared/SUPPORT_API_TOKEN` for the Support agent).
- **Site**: www.getcollectionscopilot.com live; `/support` page live; $15/$29 pricing matches in-app.
- **Stripe App scaffold**: repointed to Railway (PR #26 merged; build verified, 0 dead-proxy refs).

## ⏳ Owner steps (in order)

### 1. Persist the database — ✅ DONE (2026-08-11)
Volume `stripe-cc-volume` created (500MB) and attached to Stripe-CC at mount path `/data`;
`DB_PATH=/data/app.db` set on Railway. Deploy SUCCESS, `/health` ok, no boot errors — the
SQLite DB now survives deploys.

### 2. Stripe live mode — ✅ DONE (2026-08-11)
- ✅ `STRIPE_SECRET_KEY` **live** (`sk_live_…`, owner-provided).
- ✅ `STRIPE_WEBHOOK_SECRET` **live** (owner-provided; endpoint `https://stripe-cc-production.up.railway.app/webhook` with invoice.created/updated/paid, charge.refunded, dispute.created, account.application.deauthorized).
- ✅ `STRIPE_BILLING_WEBHOOK_SECRET` **live** (owner-provided; endpoint `https://stripe-cc-production.up.railway.app/billing` with checkout.session.completed, customer.subscription.deleted, customer.subscription.updated).
- All three set on Railway 2026-08-11; redeploys SUCCESS; `/health` ok.
- ℹ️ `STRIPE_CLIENT_ID` (`ca_…`) is account-level (no test/live variant) — leave as-is.

### 3. OPENAI_API_KEY (optional but recommended)
Not currently set — AI-personalized draft copy falls back to templates (safe). Set it on Railway
to enable the LLM-drafted emails the homepage implies.

### 4. Deploy the Stripe App
On your own machine (Stripe CLI logged in — `stripe login`), from the repo root:
```
./deploy-app.sh
```
(script installs deps, builds, runs `stripe apps upload`). Then in the Stripe dashboard:
**Developers → Apps → CollectionsCopilot → Submit for review** — public marketplace listing
requires Stripe's approval (usually a few business days). Manifest + views already point at the
Railway backend (#26); `distribution_type` is `public`; app version 0.1.7.

### 5. support@ delivery
Point `support@getcollectionscopilot.com` so it delivers to the team's monitored inbox
(stripecopilot@outlook.com). This is the prerequisite for the published priority-support promise
(site copy + ops APIs are already live).

### 6. Marketplace email unify
Update the Stripe App listing's support email from `stripecopilot@outlook.com` →
`support@getcollectionscopilot.com` (one field in the Stripe dashboard listing).

### 7. Free-tier visibility — DECIDED (owner, 2026-08-11): **keep as-is**
Non-subscribed merchants connect Stripe and see the dashboard with up to 5 AI-drafted reminders;
paid features are 402-gated; pricing is shown; nothing sends. No code change needed.

## 🧪 E2E send test (after owner has time)
Runbook: `/home/team/shared/E2E-SEND-TEST.md` — proves a real production email lands in the
inbox (not spam) with a working unsubscribe link before any real customer sends. Then checklist
item 4.5 (email delivery) can be marked live-tested.

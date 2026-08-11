# DEPLOY.md — CollectionsCopilot production launch checklist

**Status (2026-08-11):** backend is feature-complete for the homepage promise; production
(`https://stripe-cc-production.up.railway.app`) is healthy; email delivery is configured (Resend,
domain verified); support ops APIs are live. This file is the launch checklist the team owes the
owner — what's verified live, and the remaining owner steps in order.

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

### 1. Persist the database (important — data resets on every deploy today)
The app uses a local SQLite file; Railway's filesystem is ephemeral, so the DB (merchants, tasks,
drafts, opt-outs, subscriptions) is wiped on every deploy. Fix: in the Railway dashboard, add a
**volume mounted at `/data`** for the Stripe-CC service (paid add-on), then set
`DB_PATH=/data/app.db` as a variable. Without this, no data survives a deploy.

### 2. Stripe live mode — PARTIALLY DONE (2026-08-11)
- ✅ `STRIPE_SECRET_KEY` now **live** (`sk_live_…`, owner-provided, set on Railway 2026-08-11;
  redeploy SUCCESS, `/health` ok).
- ⏳ **Remaining: live webhook endpoints + signing secrets.** The current
  `STRIPE_WEBHOOK_SECRET` and `STRIPE_BILLING_WEBHOOK_SECRET` values belong to the TEST-mode
  webhook endpoints. In the Stripe dashboard (live account → Developers → Webhooks) register:
  - Main endpoint `https://stripe-cc-production.up.railway.app/webhook` with events
    `invoice.created`, `invoice.updated`, `invoice.paid`, `charge.refunded`,
    `dispute.created`, `account.application.deauthorized` → paste its signing secret
    (`whsec_…`) into `STRIPE_WEBHOOK_SECRET` on Railway.
  - Billing webhook endpoint → paste its signing secret into `STRIPE_BILLING_WEBHOOK_SECRET`.
  Until then, live events won't verify and the pipeline won't fire from them.
- ℹ️ `STRIPE_CLIENT_ID` (`ca_…`) is account-level (no test/live variant) — leave as-is.

### 3. OPENAI_API_KEY (optional but recommended)
Not currently set — AI-personalized draft copy falls back to templates (safe). Set it on Railway
to enable the LLM-drafted emails the homepage implies.

### 4. Deploy the Stripe App
```
cd stripe-app && bun run build && stripe apps deploy
```
then submit for Stripe public review. Manifest + views already point at the Railway backend (#26).

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

#!/usr/bin/env bash
# CollectionsCopilot — Stripe App deploy script (run on your own machine).
# Prereqs: Stripe CLI installed + logged in (`stripe login`), Node or Bun available.
# Usage: ./deploy-app.sh
#
# NOTE: `stripe apps upload` requires an npm/yarn/pnpm lockfile to package the
# app — `bun.lock` is NOT recognized ("failed to find any package manager
# lockfiles"). The build below always generates package-lock.json via npm
# before uploading, even when bun is used for the (faster) vite build.
set -euo pipefail
cd "$(dirname "$0")/stripe-app"
if ! command -v stripe >/dev/null 2>&1; then
  echo "❌ Stripe CLI not found. Install it first: https://docs.stripe.com/stripe-cli"
  echo "   (macOS: brew install stripe/stripe-cli/stripe)"
  exit 1
fi
if ! stripe whoami >/dev/null 2>&1; then
  echo "❌ Not logged in. Run: stripe login"
  exit 1
fi
echo "▶ Installing dependencies…"
if command -v bun >/dev/null 2>&1; then
  bun install >/dev/null
  npm install --package-lock-only --ignore-scripts >/dev/null
else
  npm install >/dev/null
fi
echo "▶ Building the app…"
if command -v bun >/dev/null 2>&1; then
  bun run build
else
  npm run build
fi
echo "▶ Build OK. Uploading to Stripe…"
stripe apps upload --non-interactive
echo "✅ Uploaded. Next: Stripe dashboard → Developers → Apps → CollectionsCopilot → Submit for review"

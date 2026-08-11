#!/usr/bin/env bash
# CollectionsCopilot — Stripe App deploy script (run on your own machine).
# Prereqs: Stripe CLI installed + logged in (`stripe login`), Node or Bun available.
# Usage: ./deploy-app.sh
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

echo "▶ Building the app…"
if command -v bun >/dev/null 2>&1; then
  bun install >/dev/null
  bun run build
else
  npm install >/dev/null
  npm run build
fi
echo "▶ Build OK. Uploading to Stripe…"
stripe apps upload
echo "✅ Uploaded. Next: Stripe dashboard → Developers → Apps → CollectionsCopilot → Submit for review"

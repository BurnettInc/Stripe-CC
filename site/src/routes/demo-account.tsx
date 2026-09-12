import { createFileRoute } from "@tanstack/react-router";
import { buildDemoDoc, HANDOFF_ANCHOR, DemoPageShell } from "../components/demoShim";

/* The LIVE Account page (served at /account by the backend) is the single
 * source of truth — bundled in verbatim so the demo renders pixel-identical. */
import accountHtml from "../../../app/src/ui/account.html?raw";

/* Public /demo-account — exact replica of the real Account page (app/src/
 * ui/account.html): subscription/plan card, billing actions, account data.
 * The shared demo shim answers its read endpoints (/settings, /stats,
 * /subscription) and BLOCKS the real-account actions with the honest
 * notice: /stripe/connect, /billing/checkout + /billing/portal (real
 * money), /account/export, /account/delete and beta redemption. The
 * "Export my data" link and both "/stripe/connect" links keep the notice —
 * they genuinely need a real account. */
const DEMO_ACCOUNT_DOC = buildDemoDoc(accountHtml, HANDOFF_ANCHOR);

export const Route = createFileRoute("/demo-account")({
  component: DemoAccount,
});

function DemoAccount() {
  return (
    <DemoPageShell
      banner="⚠ Demo Mode — sample data only, nothing sends, nothing is saved"
      heading="See the account &amp; billing page in action"
      body="Every plan, price, and status below is made-up sample data — nothing here is real, no card is charged, and nothing is saved. This is the same Account page a merchant sees: subscription status, plan pricing, billing entry points, and account data. Billing, Stripe connect and export are the only things disabled in the demo — they need a real Stripe account and real money, so they point you to the real app."
      activeTab="account"
      frameTitle="Collections Copilot account demo (exact replica)"
      srcDoc={DEMO_ACCOUNT_DOC}
      minHeight={800}
    />
  );
}
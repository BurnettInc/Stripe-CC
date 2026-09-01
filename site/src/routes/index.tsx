import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { readFile } from "node:fs/promises";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import { SiteCTA } from "../components/SiteCTA";
import {
  CARD,
  CARD_BASE,
  BORDER_DEFAULT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  Check,
  PY_MAIN,
  PY_RELATED,
  STATUS_AUTO,
  TYPE,
} from "../components/ui";

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";

const getBusinessName = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const cfg = JSON.parse(await readFile("site.json", "utf8")) as {
      businessName?: string;
    };
    return cfg.businessName?.trim() ?? "";
  } catch {
    return "";
  }
});

export const Route = createFileRoute("/")({
  loader: () => getBusinessName(),
  component: Home,
});

function Home() {
  const businessName = Route.useLoaderData();
  return (
    <div className="min-h-dvh">
      <SiteNav businessName={businessName} />

      {/* Hero — two column */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-14">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          {/* Left column */}
          <div className="text-left">
            <p className="mb-6 text-lg font-semibold text-gray-900">
              Automatic follow-ups for unpaid Stripe invoices.
            </p>
            <div className="mb-6 space-y-3">
              <span className="inline-block rounded-full bg-green-600 px-5 py-2 text-sm font-bold text-white shadow-md">
                Sign up today and receive a free month — no card required
              </span>
              <div className="flex flex-wrap gap-x-3 gap-y-2">
                <span className="inline-block rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-700">
                  Now live on the Stripe App Marketplace
                </span>
                <span className="inline-block rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-700">
                  We never sell your data
                </span>
              </div>
            </div>
            <h1 className={TYPE.hero}>
              You didn't forget to follow up. You've just been avoiding it.
            </h1>
            <p className={`mt-6 max-w-xl ${TYPE.bodyLg}`}>
              Collections Copilot chases down your overdue Stripe invoices for you
              — no new tool, no new login, no data to export. Start read-only.
              Decide how much you want to hand off, whenever you're ready.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-4">
              <a href={INSTALL_URL} className={BTN_PRIMARY}>
                Install from the Stripe App Marketplace
              </a>
              <a href="/how-it-works" className={BTN_SECONDARY}>
                How it works
              </a>
            </div>
            <p className="mt-3 text-sm text-gray-500">
              Stripe access is read-only — nothing ever sends without your approval.
            </p>
          </div>

          {/* Right column — email preview */}
          <div>
            <div className={`mx-auto max-w-md ${CARD}`}>
              {/* preview header */}
              <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-base font-bold text-indigo-700">
                  A
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-gray-900">
                    Alex at ACME Services
                  </p>
                  <p className="text-xs text-gray-500">to Sarah</p>
                </div>
              </div>
              {/* preview body */}
              <div className="px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                  Email preview
                </p>
                <p className="text-sm font-semibold text-gray-900">
                  Quiet nudge — invoice #1024
                </p>
                <div className="mt-2 space-y-2 text-sm text-gray-700 leading-relaxed">
                  <p>Hi Sarah,</p>
                  <p>
                    Hope the new site launch went well this week. Just a quick
                    heads-up that invoice #1024 for the landing page redesign ($450)
                    passed its due date — no rush if it's just slipped your mind.
                  </p>
                  <p>Let me know if anything looks off.</p>
                  <p className="font-medium">Cheers, Alex at ACME Services</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Sample — one representative drafted email (full 3-stage detail lives on /how-it-works) */}
      <section className={`max-w-6xl mx-auto px-6 ${PY_RELATED}`}>
        <div className="mb-5">
          <span className="inline-block rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600">
            Sample · see it before you connect anything
          </span>
        </div>
        <h2 className={TYPE.h2}>
          Here's a sample account with{" "}
          <span className="text-indigo-600">$2,150</span> in overdue invoices.
        </h2>
        <p className={`mt-4 max-w-3xl ${TYPE.bodyLg}`}>
          No Stripe connection needed to see this — this is an illustrative
          example, not a real customer's data. Here's one representative email
          Collections Copilot would draft for a single invoice from that account.
        </p>

        {/* Sample — invoice card (left) + drafted email (right), matched pair */}
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2">
          {/* Invoice card */}
          <div className={`flex flex-col ${CARD}`}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  Acme LLC — Invoice #1042
                </p>
                <p className="mt-0.5 text-xs text-gray-500">
                  12 days overdue · last contacted 4 days ago
                </p>
              </div>
            </div>
            <div className="flex flex-1 flex-col justify-center px-5 py-6">
              <p className="text-3xl font-bold text-gray-900">$450</p>
              <p className="mt-1 text-xs text-gray-500">
                Open invoice on the account above
              </p>
            </div>
          </div>

          {/* Drafted email card */}
          <div className={`flex flex-col ${CARD}`}>
            <div className="border-b border-gray-100 px-5 py-4">
              <h3 className={TYPE.h3}>
                What Collections Copilot would draft for this invoice
              </h3>
              <p className="mt-1 text-xs text-gray-500 leading-relaxed">
                The first of a three-stage sequence — see{" "}
                <a href="/how-it-works" className="text-indigo-600 underline">
                  How it works
                </a>{" "}
                for the full escalation.
              </p>
            </div>
            <div className="flex-1 p-5">
              <div className={`overflow-hidden ${CARD_BASE} ${BORDER_DEFAULT}`}>
                <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50 px-5 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                    Y
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900">
                      You &lt;you@yourbusiness.com&gt;
                    </p>
                    <p className={`text-xs ${STATUS_AUTO}`}>
                      Sent automatically · Day 1–6
                    </p>
                  </div>
                </div>
                <div className="px-5 py-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                    Subject
                  </p>
                  <p className="text-sm font-semibold text-gray-900">
                    Quick nudge — invoice #1042
                  </p>
                  <p className="mt-2 text-sm text-gray-700 leading-relaxed">
                    “Hey Sarah, just a heads-up that invoice #1042 passed its due
                    date — no rush if it slipped your mind.”
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className={`max-w-4xl mx-auto px-6 ${PY_MAIN}`}>
        <h2 className={`${TYPE.h2Center} mb-4`}>Simple pricing</h2>
        <p className="text-center text-gray-600 max-w-3xl mx-auto mb-10 text-sm leading-relaxed">
          Every plan starts with a free 30-day trial — full access, no card
          required. After that: Draft Mode stays free forever (5 drafts), or
          subscribe to keep Standard/Pro features.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              name: "Free — Draft Mode",
              price: "Free forever, no card required",
              period: "",
              body: "Your first month after install is completely free — full access, no card required. After that, keep Draft Mode free forever: connect your Stripe account and see AI-drafted reminders for your real overdue invoices — up to 5 drafts. Approve each send yourself, or let friendly Stage-1 reminders go automatically in Semi-Auto. Subscribe when you want more.",
              features: [],
              cta: "Try it free",
              highlight: true,
              free: true,
            },
            {
              name: "Standard",
              price: "$7",
              period: "/month",
              priceSub: "$50/year (save $34)",
              trialBadge: "First month free — full access, no card required",
              tier: "standard",
              body: "Unlock sending with Trust Mode and run personalized reminder sequences for your overdue invoices.",
              features: [
                "Up to 50 overdue invoices tracked",
                "3-stage escalation ladder",
                "Custom sender branding",
                "Weekly recovery reports",
                "Trust Mode selector + sending",
              ],
              highlight: true,
              free: false,
            },
            {
              name: "Pro",
              price: "$15",
              period: "/month",
              priceSub: "$100/year (save $80)",
              trialBadge: "First month free — full access, no card required",
              tier: "pro",
              body: "Unlock sending at scale with fully autonomous collections and advanced controls.",
              features: [
                "Everything in Standard",
                "Unlimited overdue invoices",
                "Custom escalation timing",
                "Late-fee automation",
                "Priority support — same-business-day first response (typically within 24 hours, weekdays)",
              ],
              highlight: true,
              free: false,
            },
          ].map((plan) => (
            <div
              key={plan.name}
              className={`flex flex-col ${CARD_BASE} p-8 ${
                plan.highlight
                  ? "border border-indigo-300 ring-2 ring-indigo-600"
                  : BORDER_DEFAULT
              }`}
            >
              <h3 className={TYPE.h3}>{plan.name}</h3>
              <p className={`mt-4 ${plan.free ? "text-lg font-semibold" : ""}`}>
                <span
                  className={
                    plan.free
                      ? "text-xl font-bold text-gray-900"
                      : "text-4xl font-bold text-gray-900"
                  }
                >
                  {plan.price}
                </span>
                <span className="text-gray-500">{plan.period}</span>
              </p>
              {plan.priceSub && (
                <p className="mt-1 text-sm text-gray-500">{plan.priceSub}</p>
              )}
              {plan.trialBadge && (
                <span className="mt-3 inline-block w-fit rounded-full bg-green-50 px-3 py-1 text-xs font-semibold text-green-700 ring-1 ring-green-200">
                  {plan.trialBadge}
                </span>
              )}
              <p className="mt-4 min-h-12 text-sm text-gray-600 leading-relaxed">
                {plan.body}
              </p>
              <ul className="mt-6 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                    <Check />
                    {f}
                  </li>
                ))}
              </ul>
              {plan.name === "Pro" && (
                <p className="mt-4 text-xs text-gray-400 leading-relaxed">
                  Late fee legality and limits vary by state/country — you're
                  responsible for confirming your late fee terms comply with
                  applicable law before enabling this feature.
                </p>
              )}
              {plan.free ? (
                <a
                  href={INSTALL_URL}
                  className={`mt-auto block w-full ${BTN_SECONDARY}`}
                >
                  {plan.cta}
                </a>
              ) : (
                <a
                  href={INSTALL_URL}
                  className={`mt-auto block w-full ${
                    plan.highlight ? BTN_PRIMARY : BTN_SECONDARY
                  }`}
                >
                  Install from the Stripe App Marketplace
                </a>
              )}
            </div>
          ))}
        </div>
        <p className="mt-8 text-sm text-gray-500 text-center">
          Install from the Stripe App Marketplace — subscribe inside the app after
          connecting. Every tier is free for your first 30 days, no card required.
          Then $7/mo or $50/yr Standard · $15/mo or $100/yr Pro.
        </p>
      </section>

      <SiteCTA />

      <SiteFooter businessName={businessName} />
    </div>
  );
}

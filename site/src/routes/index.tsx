import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { readFile } from "node:fs/promises";

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
      {/* Nav */}
      <nav className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-6 py-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center justify-center rounded-lg bg-indigo-50 p-1.5 ring-1 ring-indigo-100">
            <img src="/icon.svg" alt="CollectionsCopilot" className="h-9 w-auto" />
          </span>
          <span className="text-lg sm:text-xl tracking-tight text-gray-900">
            {(() => {
              const name = businessName || "CollectionsCopilot";
              const idx = name.lastIndexOf("Copilot");
              if (idx > 0) {
                return (
                  <>
                    {name.slice(0, idx)}
                    <span className="font-bold text-indigo-700">{name.slice(idx)}</span>
                  </>
                );
              }
              return name;
            })()}
          </span>
        </div>
      </nav>

      {/* Hero — two column */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-14">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          {/* Left column */}
          <div className="text-left">
            <div className="mb-6">
              <span className="inline-block rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-700">
                Now live on the Stripe App Marketplace
              </span>
              <span className="inline-block rounded-full bg-purple-100 px-3 py-1 text-sm font-medium text-purple-700 ml-2 mt-2 sm:mt-0">
                We never sell your data
              </span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight sm:text-5xl text-gray-900">
              Built for solo Stripe sellers — no Xero, no QuickBooks, no AR team required
            </h1>
            <p className="mt-6 max-w-xl text-lg text-gray-600 leading-relaxed">
              Not another form-letter reminder. CollectionsCopilot writes polite,
              personalized follow-ups that escalate naturally — so you get paid without
              damaging the relationship.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-4">
              <a
                href={INSTALL_URL}
                className="rounded-lg bg-indigo-600 px-6 py-3 text-center text-base font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
              >
                Install from the Stripe App Marketplace
              </a>
              <a
                href="#how-it-works"
                className="rounded-lg border border-gray-300 px-6 py-3 text-center text-base font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                How it works
              </a>
            </div>
          </div>

          {/* Right column — email preview */}
          <div>
            <div className="mx-auto max-w-md rounded-2xl border border-gray-200 bg-white shadow-lg">
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
                    Hope the new site launch went well this week. Just a quick heads-up
                    that invoice #1024 for the landing page redesign ($450) passed its
                    due date — no rush if it's just slipped your mind.
                  </p>
                  <p>Let me know if anything looks off.</p>
                  <p className="font-medium">Cheers, Alex at ACME Services</p>
                </div>
              </div>
            </div>
          </div>
        </div>

      </section>

      {/* Sample — see it before you connect anything (honest, illustrative example) */}
      <section className="max-w-6xl mx-auto px-6 py-14">
        <div className="mb-5">
          <span className="inline-block rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-600">
            Sample · see it before you connect anything
          </span>
        </div>
        <h2 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          Here's a sample account with{" "}
          <span className="text-amber-500">$18,420</span> in overdue invoices.
        </h2>
        <p className="mt-4 max-w-3xl text-lg text-gray-600 leading-relaxed">
          No Stripe connection needed to see this — this is an illustrative
          example, not a real customer's data. Here's what CollectionsCopilot
          would draft for one invoice from that account, start to finish.
        </p>

        {/* Sample invoice card */}
        <div className="mt-8 max-w-xl rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-gray-900">
                Acme LLC — Invoice #1042
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                23 days overdue · last contacted 9 days ago
              </p>
            </div>
            <span className="inline-flex shrink-0 items-center rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-800">
              Recommended: Stage 2
            </span>
          </div>
          <div className="px-5 py-4">
            <p className="text-2xl font-bold text-gray-900">$7,500</p>
          </div>
        </div>

        {/* Three-stage sequence */}
        <h3 className="mt-10 text-lg font-semibold text-gray-900">
          What CollectionsCopilot would draft for this invoice
        </h3>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Stage 1 — calm teal */}
          <div className="rounded-xl border border-teal-200 bg-teal-50 p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-teal-700">
                Stage 1 · Friendly
              </span>
              <span className="text-right text-xs font-medium text-gray-500">
                Day 1–6
              </span>
            </div>
            <p className="text-sm text-gray-700 italic leading-relaxed">
              \u201cHey Sarah, just a heads-up that invoice #1042 passed its due date — no rush if it slipped your mind.\u201d
            </p>
          </div>
          {/* Stage 2 — amber */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-amber-700">
                Stage 2 · Firmer
              </span>
              <span className="text-right text-xs font-medium text-gray-500">
                Day 7–20
              </span>
            </div>
            <p className="text-sm text-gray-700 italic leading-relaxed">
              \u201cFollowing up on invoice #1042 ($7,500, due last month). It's now 23 days past due — is anything blocking payment on your end?\u201d
            </p>
          </div>
          {/* Stage 3 — muted red */}
          <div className="rounded-xl border border-red-200 bg-red-50 p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-red-700">
                Stage 3 · Final
              </span>
              <span className="text-right text-xs font-medium text-gray-500">
                Day 21+
              </span>
            </div>
            <p className="text-sm text-gray-700 italic leading-relaxed">
              \u201cFinal notice before further follow-up. Please settle invoice #1042 at your earliest convenience.\u201d
            </p>
          </div>
        </div>

        {/* Footer — CTA */}
        <div className="mt-10 flex flex-col items-start justify-between gap-6 rounded-2xl border border-gray-200 bg-gray-50 p-6 md:flex-row md:items-center">
          <p className="max-w-xl text-sm text-gray-600 leading-relaxed">
            Connect Stripe to see this same breakdown for your actual invoices —
            read-only access, and nothing sends without your approval in Draft Mode.
          </p>
          <div className="flex flex-col items-start gap-2 md:items-end">
            <a
              href={INSTALL_URL}
              className="rounded-lg bg-indigo-600 px-6 py-3 text-center text-base font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
            >
              Connect Stripe to see your numbers
            </a>
            <span className="text-xs text-gray-500">
              First 30 days free — full access, no card required · then Draft Mode is free forever
            </span>
          </div>
        </div>
      </section>

      {/* Why we're different from Stripe — moved up from the FAQ */}
      <section className="max-w-4xl mx-auto px-6 py-12">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 sm:p-10">
          <h2 className="text-2xl font-bold text-gray-900 mb-3">
            How is this different from Stripe's built-in reminders?
          </h2>
          <p className="text-gray-600 leading-relaxed">
            Stripe's native reminders send one-size-fits-all notifications —
            CollectionsCopilot escalates through multiple stages with personalized
            context, and gives you control over when and how each follow-up goes out.
            Stripe's tool reminds; ours recovers.
          </p>
        </div>
      </section>
      {/* Trust & Transparency */}
      <section id="trust" className="bg-gray-50 py-16">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
            Trust &amp; Transparency
          </h2>
          <p className="text-center text-gray-600 max-w-xl mx-auto mb-8">
            You're trusting us with your customers and your cash flow. Here's exactly
            what we ask for — and what we never do.
          </p>

          {/* Condensed comparison */}
          <h3 className="text-lg font-semibold text-gray-900 text-center mb-3">
            Why we're different
          </h3>
          <p className="text-center text-sm text-gray-500 mb-6">
            Same invoice, two very different follow-ups.
          </p>
          <div className="grid gap-6 md:grid-cols-2 mb-10">
            <div className="rounded-xl border border-gray-300 bg-white p-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Typical automated reminder
              </p>
              <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-700">
                <p className="font-medium">Subject: Invoice #1024 is overdue</p>
                <p className="mt-1">Your invoice #1024 ($450) is 5 days overdue. Please remit payment.</p>
              </div>
            </div>
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-6 relative">
              <span className="absolute -top-3 right-4 rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-semibold text-white">
                CollectionsCopilot
              </span>
              <p className="text-xs font-semibold text-indigo-400 uppercase tracking-wide mb-3">
                Personalized, relationship-aware
              </p>
              <div className="rounded-lg bg-white p-4 text-sm text-gray-700 shadow-sm">
                <p className="font-medium">Subject: Quiet nudge — invoice #1024</p>
                <p className="mt-1">Hi Sarah, just a heads-up that invoice #1024 passed its due date — no rush.</p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            {/* Permissions */}
            <div className="rounded-2xl border border-gray-200 bg-white p-8">
              <h3 className="text-lg font-bold text-gray-900">
                Permissions
              </h3>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                Matched to what Stripe shows you at install — nothing more, nothing
                hidden:
              </p>
              <ul className="mt-4 space-y-3">
                <li className="flex items-start gap-3 text-sm">
                  <span className="text-gray-700">
                    <span className="font-semibold text-gray-900">
                      Account &amp; user information — read-only.
                    </span>{" "}
                    How we know which account you are.{" "}
                    <span className="text-gray-500">
                      (A baseline Stripe grants every app — we don't request or
                      modify anything.)
                    </span>
                  </span>
                </li>
                <li className="flex items-start gap-3 text-sm">
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 shrink-0">
                    customer_read
                  </code>
                  <span className="text-gray-700">
                    <span className="font-semibold text-gray-900">
                      Customers — read-only.
                    </span>{" "}
                    Names &amp; emails, so reminders are addressed right.
                  </span>
                </li>
                <li className="flex items-start gap-3 text-sm">
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 shrink-0">
                    invoice_read
                  </code>
                  <span className="text-gray-700">
                    <span className="font-semibold text-gray-900">
                      Invoices — read-only.
                    </span>{" "}
                    Which invoices are overdue and by how much.
                  </span>
                </li>
                <li className="flex items-start gap-3 text-sm">
                  <span className="text-gray-700">
                    <span className="font-semibold text-gray-900">
                      External access — data sharing.
                    </span>{" "}
                    We connect to our own backend to prepare and send your reminders;
                    no third parties.
                  </span>
                </li>
              </ul>
              <p className="mt-4 text-sm text-gray-500">
                No write permissions. The app can't modify invoices, customers, or
                payment methods. Read-only means read-only — nothing is ever changed.
              </p>
            </div>

            {/* Pause & cancel */}
            <div className="rounded-2xl border border-gray-200 bg-white p-8">
              <h3 className="text-lg font-bold text-gray-900">
                Pause &amp; cancel, any time
              </h3>
              <ul className="mt-4 space-y-4 text-sm text-gray-700">
                <li className="flex items-start gap-3">
                  <span className="text-indigo-600 mt-0.5">✓</span>
                  <span>
                    <span className="font-semibold text-gray-900">Switch to Draft Mode</span>{" "}
                    and all auto-sending pauses instantly. No emails go out without your
                    approval in Draft mode.
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="text-indigo-600 mt-0.5">✓</span>
                  <span>
                    You can{" "}
                    <span className="font-semibold text-gray-900">
                      disconnect your Stripe account
                    </span>{" "}
                    at any time from the Stripe Dashboard — sequences stop immediately.
                  </span>
                </li>
              </ul>
            </div>
          </div>

          {/* Not a debt collection service */}
          <div className="rounded-2xl border border-gray-200 bg-white p-8">
            <h3 className="text-lg font-bold text-gray-900">
              Not a debt collection service
            </h3>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">
              CollectionsCopilot sends polite, personalized payment reminders — never
              legal threats, never harassment. Our AI is explicitly instructed to
              preserve your customer relationships, not damage them. If you need formal
              debt collection, this isn't the tool for that.
            </p>
          </div>

          {/* Reply handling */}
          <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-8">
            <h3 className="text-lg font-bold text-gray-900">
              What happens if a customer replies?
            </h3>
            <p className="mt-3 text-sm text-gray-700 leading-relaxed">
              If a customer replies to any reminder, their sequence pauses automatically
              and you're notified immediately — no more reminders go out until you resume
              it. Their message is also forwarded straight to your inbox, so you never
              miss it.
            </p>
          </div>

          {/* Your trust, in one summary strip */}
          <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
              <span className="text-indigo-600 mt-0.5 shrink-0">✓</span>
              <p className="text-sm text-gray-700">
                <span className="font-semibold text-gray-900">Read-only access</span>
                {" "}— we never modify your Stripe data.
              </p>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
              <span className="text-indigo-600 mt-0.5 shrink-0">✓</span>
              <p className="text-sm text-gray-700">
                <span className="font-semibold text-gray-900">No write access</span>
                {" "}— your customers' accounts stay untouched.
              </p>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
              <span className="text-indigo-600 mt-0.5 shrink-0">✓</span>
              <p className="text-sm text-gray-700">
                <span className="font-semibold text-gray-900">Pause or stop anytime</span>
                {" "}— the sequence halts the instant a payment is detected.
              </p>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-gray-200 bg-white p-4">
              <span className="text-indigo-600 mt-0.5 shrink-0">✓</span>
              <p className="text-sm text-gray-700">
                <span className="font-semibold text-gray-900">You approve every send in Draft mode</span>
                {" "}— trust grows from there.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-10">
          Simple pricing
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              name: "Free — Draft Mode",
              price: "Free forever, no card required",
              period: "",
              body: "First 30 days after you install are fully free — full access with no card required. After that, keep Draft Mode free forever: connect your Stripe account and see AI-drafted reminders for your real overdue invoices — up to 5 drafts. Approve each send yourself, or let friendly Stage-1 reminders go automatically in Semi-Auto. Subscribe when you want more.",
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
              className={`flex flex-col rounded-2xl border p-8 ${
                plan.highlight
                  ? "border-indigo-300 ring-2 ring-indigo-600 shadow-lg"
                  : "border-gray-200"
              }`}
            >
              <h3 className="text-xl font-bold text-gray-900">{plan.name}</h3>
              <p className={`mt-4 ${plan.free ? "text-lg font-semibold" : ""}`}>
                <span className={plan.free ? "text-xl font-bold text-gray-900" : "text-4xl font-bold text-gray-900"}>
                  {plan.price}
                </span>
                <span className="text-gray-500">{plan.period}</span>
              </p>
              {plan.priceSub && (
                <p className="mt-1 text-sm text-gray-500">{plan.priceSub}</p>
              )}
              <p className="mt-4 min-h-12 text-sm text-gray-600 leading-relaxed">{plan.body}</p>
              <ul className="mt-6 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-green-500 mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              {plan.name === "Pro" && (
                <p className="mt-4 text-xs text-gray-400 leading-relaxed">
                  Late fee legality and limits vary by state/country — you're responsible for confirming your late fee terms comply with applicable law before enabling this feature.
                </p>
              )}
              {plan.free ? (
                <a
                  href={INSTALL_URL}
                  className="mt-auto block w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                >
                  {plan.cta}
                </a>
              ) : (
                <a
                  href={INSTALL_URL}
                  className={`mt-auto block w-full rounded-lg px-4 py-3 text-center text-sm font-semibold transition-colors ${
                    plan.highlight
                      ? "bg-indigo-600 text-white hover:bg-indigo-700"
                      : "border border-gray-300 text-gray-700 hover:bg-gray-50"
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
          connecting. $7/mo or $50/yr Standard · $15/mo or $100/yr Pro.
        </p>
      </section>

      {/* How it works — detailed escalation */}
      <section id="how-it-works" className="bg-gray-50 py-16">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-4">
            How it works
          </h2>
          <p className="text-center text-gray-600 max-w-xl mx-auto mb-8 leading-relaxed">
            Unlike other tools, we give you control from day one — you start exactly as
            hands-on as you want, and earn your way to hands-off. Here's what every
            sequence and mode does.
          </p>

          {/* Escalation ladder */}
          <h3 className="text-lg font-semibold text-gray-900 text-center mb-6">
            Every sequence escalates in three stages
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
            {[
              {
                when: "Day 1–6",
                stage: "Stage 1 · Friendly reminder",
                example: "\u201cHey Alex, just a quick nudge that invoice #1042 for $450 was due yesterday…\u201d",
              },
              {
                when: "Day 7–20",
                stage: "Stage 2 · Firmer follow-up",
                example: "\u201cFollowing up on invoice #1042 ($450, due Jun 1). It's now 9 days past due — is anything blocking payment on your end?\u201d",
              },
              {
                when: "Day 21+",
                stage: "Stage 3 · Final notice",
                example: "\u201cFinal notice before further follow-up. Please settle invoice #1042 at your earliest convenience.\u201d",
              },
            ].map((s) => (
              <div
                key={s.when}
                className="rounded-xl border border-gray-200 bg-white p-5"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-bold uppercase tracking-wide text-indigo-600 shrink-0">
                    {s.when}
                  </span>
                  <span className="text-xs font-medium text-gray-500 text-right">
                    {s.stage}
                  </span>
                </div>
                <p className="text-sm text-gray-600 italic leading-relaxed">
                  {s.example}
                </p>
              </div>
            ))}
          </div>

          {/* What each mode sends, per stage */}
          <h3 className="text-lg font-semibold text-gray-900 text-center mb-6">
            What each mode sends, per stage
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            {[
              {
                mode: "Draft",
                tagline: "You approve everything",
                color: "bg-blue-50 border-blue-200",
                behavior: [
                  { when: "Day 1–6", action: "Drafted & queued for your approval", auto: false },
                  { when: "Day 7–20", action: "Drafted & queued for your approval", auto: false },
                  { when: "Day 21+", action: "Drafted & queued for your approval", auto: false },
                ],
                note: "Every email is drafted and queued for your approval. Nothing sends without you — ever.",
              },
              {
                mode: "Semi-Auto",
                tagline: "Friendly reminders send themselves",
                color: "bg-amber-50 border-amber-200",
                behavior: [
                  { when: "Day 1–6", action: "Auto-sends", auto: true },
                  { when: "Day 7–20", action: "Waits for your approval", auto: false },
                  { when: "Day 21+", action: "Waits for your approval", auto: false },
                ],
                note: "Stage 1 friendly reminders run on their own. Stages 2–3 still wait for your sign-off.",
              },
              {
                mode: "Full Auto",
                tagline: "Fully hands-off",
                color: "bg-green-50 border-green-200",
                behavior: [
                  { when: "Day 1–6", action: "Auto-sends", auto: true },
                  { when: "Day 7–20", action: "Auto-sends", auto: true },
                  { when: "Day 21+", action: "Auto-sends", auto: true },
                ],
                note: "The whole sequence runs without you. You're notified when something happens — payment received, sequence escalated — never bothered to make it happen.",
              },
            ].map((mode) => (
              <div
                key={mode.mode}
                className={`rounded-xl border p-6 ${mode.color}`}
              >
                <h3 className="text-lg font-bold text-gray-900">{mode.mode} Mode</h3>
                <p className="mt-1 text-xs font-medium text-gray-500">{mode.tagline}</p>
                <ul className="mt-4 space-y-2">
                  {mode.behavior.map((b) => (
                    <li
                      key={b.when}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <span className="font-medium text-gray-700 shrink-0">{b.when}</span>
                      <span className={b.auto ? "text-green-700 font-medium text-right" : "text-gray-600 text-right"}>
                        {b.auto ? "✓ " : ""}{b.action}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-gray-700 leading-relaxed">{mode.note}</p>
              </div>
            ))}
          </div>

          {/* Payment stop guarantee */}
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-6 text-center mb-6">
            <p className="text-base font-semibold text-indigo-900">
              The moment a payment is detected, the entire sequence stops — no exceptions.
            </p>
            <p className="mt-1 text-sm text-indigo-700">
              Before every send, the pipeline re-checks the invoice. Paid? That customer's
              sequence is done.
            </p>
          </div>

          <p className="text-center text-gray-500 text-sm">
            Switch modes any time, per-customer if you want. Nothing here is locked in.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
          Frequently asked questions
        </h2>
        <p className="text-center text-gray-600 max-w-xl mx-auto mb-8">
          The honest answers to the questions we'd ask, if we were you.
        </p>
        <div className="space-y-6">
          {[
            {
              q: "Will this sound robotic?",
              a: "No. Each email is either AI-generated using your invoice history and customer context, or uses carefully written fallback templates that vary by stage. The AI is prompted to write like a human who cares about the relationship — never copy-paste, never robotic. Want to hear it before subscribing? Free Draft Mode lets you preview real drafts from your own invoices.",
            },
            {
              q: "Does this work with one-off invoices as well as recurring ones?",
              a: "Yes. CollectionsCopilot monitors your Stripe invoices regardless of whether they're one-off or subscription-based. If it's overdue in Stripe, we'll help you follow up.",
            },
            {
              q: "What happens if an invoice is disputed, voided, or marked uncollectible?",
              a: "Reminders halt automatically when an invoice is paid, voided, disputed, or marked uncollectible.",
            },
          ].map((item) => (
            <div
              key={item.q}
              className="rounded-xl border border-gray-200 p-6"
            >
              <h3 className="font-semibold text-gray-900">{item.q}</h3>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                {item.a}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="bg-gray-900 py-16">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to stop chasing payments?
          </h2>
          <p className="text-gray-400 max-w-lg mx-auto mb-4">
            Install from the Stripe App Marketplace.
            Polite, personalized, and persistent reminders — without you lifting a
            finger.
          </p>
          <p className="text-indigo-300 max-w-lg mx-auto mb-8">
            Your first 30 days are free — full access, no card required. After that,
            Draft Mode stays free forever with up to 5 drafts. Subscribe inside the app
            when you're ready for sending.
          </p>
          <div className="flex flex-col items-center gap-4">
            <a
              href={INSTALL_URL}
              className="inline-block rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white hover:bg-indigo-700 transition-colors"
            >
              Install from the Stripe App Marketplace
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-8 text-center text-sm text-gray-500">
        <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2 mb-3">
          <a href="/privacy" className="hover:text-gray-700 transition-colors">
            Privacy Policy
          </a>
          <a href="/terms" className="hover:text-gray-700 transition-colors">
            Terms of Service
          </a>
          <a href="/about" className="hover:text-gray-700 transition-colors">
            About
          </a>
          <a href="/support" className="hover:text-gray-700 transition-colors">
            Support
          </a>
        </div>
        <p>
          {businessName || "CollectionsCopilot"}
        </p>
      </footer>
    </div>
  );
}

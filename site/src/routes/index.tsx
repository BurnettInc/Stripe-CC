import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { readFile } from "node:fs/promises";
import { useState } from "react";

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

/**
 * Checkout sessions are created by the backend API (app), not here — it owns
 * the price IDs, merchant attribution, and the billing webhooks. This server
 * function only forwards the request with the visitor's session cookie so the
 * backend can attribute the subscription to the authenticated merchant.
 *
 * APP_API_URL must point at the backend in production, e.g.
 * APP_API_URL=https://api.example.com. Defaults to BASE_URL (same-origin on
 * Railway — one service serves both site and backend) and then the local
 * backend.
 */
const createCheckout = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { tier?: string };
    if (!d.tier || !["standard", "pro"].includes(d.tier)) {
      throw new Error("Invalid tier");
    }
    return d as { tier: "standard" | "pro" };
  })
  .handler(async ({ data }) => {
    const apiUrl = (process.env.APP_API_URL || process.env.BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
    const siteBase = process.env.BASE_URL || "http://localhost:3000";

    // Forward the visitor's session cookie to the backend so its
    // requireSession() gate can attribute the subscription. This is a
    // server-to-server call, so a manually forwarded Cookie header works
    // regardless of domain — no browser same-origin restrictions apply.
    // The backend sets `session=...` with Path=/ and no Domain attribute
    // (host-only for the backend origin), which is exactly what the visitor's
    // browser sends back here on every path.
    const incomingReq = getRequest();
    const cookieHeader = incomingReq?.headers.get("cookie") ?? "";
    if (!cookieHeader.split(";").some((part) => part.trim().startsWith("session="))) {
      return { error: "Connect your Stripe account before subscribing" };
    }

    try {
      const res = await fetch(`${apiUrl}/billing/checkout`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookieHeader,
        },
        body: JSON.stringify({
          tier: data.tier,
          successUrl: `${siteBase}/?subscribed=true`,
          cancelUrl: `${siteBase}/?cancelled=true`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json() as { url?: string; error?: string };
      if (res.ok && json.url) return { url: json.url };
      console.error("[checkout] Backend checkout failed:", JSON.stringify(json));
      if (res.status === 401) {
        return { error: "Connect your Stripe account before subscribing" };
      }
      return { error: json.error || "Checkout failed" };
    } catch (err) {
      console.error(`[checkout] Could not reach backend checkout at ${apiUrl}/billing/checkout:`, err instanceof Error ? err.message : String(err));
      return { error: "Checkout is temporarily unavailable. Please try again later." };
    }
  });

export const Route = createFileRoute("/")({
  loader: () => getBusinessName(),
  component: Home,
});

function SubscribeButton({ tier, label, highlight }: { tier: string; label: string; highlight?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleClick = async () => {
    setLoading(true);
    setError("");
    try {
      const result = await createCheckout({ data: { tier: tier as "standard" | "pro" } });
      if (result.url) {
        window.location.href = result.url;
      } else {
        setError(result.error || "Something went wrong");
      }
    } catch {
      setError("Something went wrong");
    }
    setLoading(false);
  };

  return (
    <div>
      <button
        onClick={handleClick}
        disabled={loading}
        className={`mt-8 block w-full rounded-lg px-4 py-3 text-center text-sm font-semibold transition-colors disabled:opacity-50 ${
          highlight
            ? "bg-indigo-600 text-white hover:bg-indigo-700"
            : "border border-gray-300 text-gray-700 hover:bg-gray-50"
        }`}
      >
        {loading ? "Redirecting..." : label}
      </button>
      {error && <p className="mt-2 text-xs text-red-600 text-center">{error}</p>}
    </div>
  );
}

function Home() {
  const businessName = Route.useLoaderData();
  return (
    <div className="min-h-dvh">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="CollectionsCopilot" className="h-8 w-auto" />
          <span className="font-bold text-lg text-indigo-600">
            {businessName || "CollectionsCopilot"}
          </span>
        </div>
        <a
          href="#pricing"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
        >
          Get Started
        </a>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
        <span className="inline-block rounded-full bg-indigo-100 px-3 py-1 text-sm font-medium text-indigo-700 mb-6">
          Stripe-native · Zero setup
        </span>
        <span className="inline-block rounded-full bg-purple-100 px-3 py-1 text-sm font-medium text-purple-700 mb-6 ml-2">
          We never sell your data
        </span>
        <h1 className="text-4xl font-bold tracking-tight sm:text-6xl text-gray-900">
          Recover invoices faster
        </h1>
        <p className="mt-6 max-w-xl mx-auto text-lg text-gray-600 leading-relaxed">
          The simplest AI collections assistant for solo Stripe users. Connect your
          Stripe account in one click, and we'll chase overdue invoices with
          personalized, escalating reminders — so you get paid without lifting a
          finger.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
          <a
            href="/dashboard"
            className="rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white hover:bg-indigo-700 transition-colors shadow-sm"
          >
            Start recovering invoices →
          </a>
          <a
            href="#how-it-works"
            className="rounded-lg border border-gray-300 px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
          >
            How it works
          </a>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="max-w-5xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-16">
          Set it and forget it
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10">
          {[
            {
              step: "1",
              title: "Connect Stripe",
              desc: "One click. No config files, no webhook setup, no API keys to copy. We handle everything.",
            },
            {
              step: "2",
              title: "Pick your Trust Mode",
              desc: "Draft (you approve), Semi-Auto (friendly reminders auto-send), or Full Auto (hands-off). You're always in control.",
            },
            {
              step: "3",
              title: "Get paid",
              desc: "When an invoice goes overdue, we send personalized, polite reminders that escalate naturally. Payment detected? Sequence stops instantly.",
            },
          ].map((item) => (
            <div key={item.step} className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-lg">
                {item.step}
              </div>
              <h3 className="mt-5 text-lg font-semibold text-gray-900">
                {item.title}
              </h3>
              <p className="mt-3 text-sm text-gray-600 leading-relaxed">
                {item.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Trust Mode */}
      <section className="bg-gray-50 py-20">
        <div className="max-w-5xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
            Most AI collections tools give you one choice: full auto, or nothing.
          </h2>
          <p className="text-center text-gray-600 max-w-xl mx-auto mb-14">
            That's a hard sell when it's your customers on the other end of the email.
            So we built it differently — you start exactly as hands-on as you want, and
            earn your way to hands-off.
          </p>

          {/* Escalation ladder */}
          <h3 className="text-lg font-semibold text-gray-900 text-center mb-6">
            Every sequence escalates in three stages
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-14">
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

      {/* Email Preview */}
      <section className="py-16">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-2xl font-bold text-center text-gray-900 mb-2">
            See the difference
          </h2>
          <p className="text-center text-gray-600 max-w-lg mx-auto mb-10">
            Same invoice, two very different follow-ups.
          </p>
          <div className="grid gap-8 md:grid-cols-2">
            <div className="rounded-xl border border-gray-300 bg-white p-6">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-4">
                Typical automated reminder
              </p>
              <div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-700 space-y-2">
                <p className="font-medium">Subject: Invoice #1024 is overdue</p>
                <p>Dear Client,</p>
                <p>Your invoice #1024 for $450.00 is now 5 days overdue. Please remit payment at your earliest convenience.</p>
                <p>Thank you,<br />ACME Services</p>
              </div>
            </div>
            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-6 relative">
              <span className="absolute -top-3 right-4 rounded-full bg-indigo-600 px-3 py-0.5 text-xs font-semibold text-white">
                CollectionsCopilot
              </span>
              <p className="text-xs font-semibold text-indigo-400 uppercase tracking-wide mb-4">
                Personalized, relationship-aware
              </p>
              <div className="rounded-lg bg-white p-4 text-sm text-gray-700 space-y-2 shadow-sm">
                <p className="font-medium">Subject: Quiet nudge — invoice #1024</p>
                <p>Hi Sarah,</p>
                <p>Hope the new site launch went well this week. Just a quick heads-up that invoice #1024 for the landing page redesign ($450) passed its due date — no rush if it's just slipped your mind.</p>
                <p>Let me know if anything looks off. Cheers,<br />Alex at ACME Services</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Trust & Transparency */}
      <section id="trust" className="bg-gray-50 py-20">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
            Trust &amp; Transparency
          </h2>
          <p className="text-center text-gray-600 max-w-xl mx-auto mb-14">
            You're trusting us with your customers and your cash flow. Here's exactly
            what we ask for — and what we never do.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            {/* Permissions we request */}
            <div className="rounded-2xl border border-gray-200 bg-white p-8">
              <h3 className="text-lg font-bold text-gray-900">
                Permissions we request
              </h3>
              <p className="mt-2 text-sm text-gray-600 leading-relaxed">
                Exactly two read-only permissions, nothing more, nothing hidden:
              </p>
              <ul className="mt-4 space-y-3">
                <li className="flex items-start gap-3 text-sm">
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 shrink-0">
                    invoice_read
                  </code>
                  <span className="text-gray-700">
                    — so we can see which invoices are overdue.
                  </span>
                </li>
                <li className="flex items-start gap-3 text-sm">
                  <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-semibold text-indigo-700 shrink-0">
                    customer_read
                  </code>
                  <span className="text-gray-700">
                    — so we know who to address and how.
                  </span>
                </li>
              </ul>
              <p className="mt-4 text-sm text-gray-500">
                No write permissions. The app can't modify invoices, customers, or
                payment methods.
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
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-4xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
          Simple pricing
        </h2>
        <p className="text-center text-gray-600 max-w-lg mx-auto mb-14">
          Draft up to 5 real overdue invoices for free. Subscribe when you're ready to
          unlock sending — no contracts, cancel in one click.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              name: "Free — Draft Mode",
              price: "Free forever, no card required",
              period: "",
              body: "Connect your Stripe account and see AI-drafted reminders for your real overdue invoices — up to 5 drafts. Nothing sends until you subscribe.",
              features: [],
              cta: "Connect your Stripe account",
              highlight: false,
              free: true,
            },
            {
              name: "Standard",
              price: "$15",
              period: "/month",
              tier: "standard",
              body: "Unlock sending with Trust Mode and run personalized reminder sequences for your overdue invoices.",
              features: [
                "Up to 50 overdue invoices tracked",
                "3-stage escalation ladder",
                "Custom sender branding",
                "Weekly recovery reports",
                "Trust Mode selector + sending",
              ],
              cta: "Subscribe to Standard",
              highlight: true,
              free: false,
            },
            {
              name: "Pro",
              price: "$29",
              period: "/month",
              tier: "pro",
              body: "Unlock sending at scale with fully autonomous collections and advanced controls.",
              features: [
                "Everything in Standard",
                "Unlimited overdue invoices",
                "Custom escalation timing",
                "Late-fee automation",
                "Priority support — same-business-day first response (typically within 24 hours, weekdays)",
              ],
              cta: "Subscribe to Pro",
              highlight: true,
              free: false,
            },
          ].map((plan) => (
            <div
              key={plan.name}
              className={`rounded-2xl border p-8 ${
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
              <p className="mt-4 min-h-12 text-sm text-gray-600 leading-relaxed">{plan.body}</p>
              <ul className="mt-6 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-green-500 mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              {plan.free ? (
                <a
                  href="/dashboard"
                  className="mt-8 block w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
                >
                  {plan.cta}
                </a>
              ) : (
                <SubscribeButton tier={plan.tier!} label={plan.cta} highlight={plan.highlight} />
              )}
              {plan.name === "Pro" && (
                <p className="mt-4 text-xs text-gray-400 leading-relaxed">
                  Late fee legality and limits vary by state/country — you're responsible for confirming your late fee terms comply with applicable law before enabling this feature.
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="max-w-4xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
          Frequently asked questions
        </h2>
        <p className="text-center text-gray-600 max-w-xl mx-auto mb-14">
          The honest answers to the questions we'd ask, if we were you.
        </p>
        <div className="space-y-6">
          {[
            {
              q: "Will this sound robotic?",
              a: "No. Each email is either AI-generated using your invoice history and customer context, or uses carefully written fallback templates that vary by stage. The AI is prompted to write like a human who cares about the relationship — never copy-paste, never robotic. Want to hear it before subscribing? Free Draft Mode lets you preview real drafts from your own invoices.",
            },
            {
              q: "Can I stop it instantly?",
              a: "Yes. Switch to Draft Mode — nothing sends without your approval. You can also disconnect your Stripe account from the Stripe Dashboard at any time, and the moment a customer pays, their sequence stops on its own.",
            },
            {
              q: "Does this work with one-off invoices as well as recurring ones?",
              a: "Yes. CollectionsCopilot monitors your Stripe invoices regardless of whether they're one-off or subscription-based. If it's overdue in Stripe, we'll help you follow up.",
            },
            {
              q: "Can I try it before paying?",
              a: "Yes — Free Draft Mode is free forever, no card required. Connect your Stripe account and see real AI-drafted reminders for up to 5 of your overdue invoices. Nothing sends until you subscribe.",
            },
            {
              q: "How is this different from Stripe's built-in reminders?",
              a: "Stripe's native reminders send one-size-fits-all notifications — CollectionsCopilot escalates through multiple stages with personalized context, and gives you control over when and how each follow-up goes out. Stripe's tool reminds; ours recovers.",
            },
            {
              q: "What if a customer disputes an invoice, or wants to stop getting reminders?",
              a: "If a customer disputes an invoice, the sequence pauses immediately — you'll be notified and can decide how to proceed. If someone wants to opt out, they can use the link in any reminder to stop follow-ups on that invoice. You can also manually pause or cancel any sequence from the dashboard.",
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
      <section className="bg-gray-900 py-20">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to stop chasing payments?
          </h2>
          <p className="text-gray-400 max-w-lg mx-auto mb-8">
            Connect your Stripe account and let CollectionsCopilot handle the
            follow-ups. Polite, personalized, and persistent — without you lifting a
            finger.
          </p>
          <a
            href="/dashboard"
            className="inline-block rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white hover:bg-indigo-700 transition-colors"
          >
            Get Started
          </a>
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
          <a
            href="mailto:support@getcollectionscopilot.com"
            className="hover:text-gray-700 transition-colors"
          >
support@getcollectionscopilot.com
          </a>
        </div>
        <p>
          {businessName || "CollectionsCopilot"}
        </p>
      </footer>
    </div>
  );
}

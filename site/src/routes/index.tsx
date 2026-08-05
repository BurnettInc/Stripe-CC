import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
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
 * function only resolves the current merchant (the same way the backend does,
 * via its /merchant endpoint) and forwards the request, so there is a single
 * checkout implementation and the metadata drift that silently broke billing
 * can't happen again.
 *
 * APP_API_URL must point at the backend in production, e.g.
 * APP_API_URL=https://api.example.com. Defaults to the local backend.
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
    const apiUrl = (process.env.APP_API_URL || "http://localhost:3001").replace(/\/+$/, "");
    const siteBase = process.env.BASE_URL || "http://localhost:3000";

    // Resolve the current merchant from the backend before creating the
    // session so the billing webhook can attribute the subscription. Never
    // hardcode a merchant id here — if none is available, fail the checkout
    // rather than create a session the backend will reject.
    let merchantId: number;
    try {
      const res = await fetch(`${apiUrl}/merchant`, { signal: AbortSignal.timeout(10_000) });
      const json = await res.json() as { id?: number };
      if (!res.ok || typeof json.id !== "number") throw new Error("no merchant id returned");
      merchantId = json.id;
    } catch (err) {
      console.error(`[checkout] Could not resolve merchant from ${apiUrl}/merchant:`, err instanceof Error ? err.message : String(err));
      return { error: "Checkout is temporarily unavailable — billing is not configured. Please try again later." };
    }

    try {
      const res = await fetch(`${apiUrl}/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: data.tier,
          merchantId,
          successUrl: `${siteBase}/?subscribed=true`,
          cancelUrl: `${siteBase}/?cancelled=true`,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = await res.json() as { url?: string; error?: string };
      if (res.ok && json.url) return { url: json.url };
      console.error("[checkout] Backend checkout failed:", JSON.stringify(json));
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
        <span className="font-bold text-lg text-indigo-600">
          {businessName || "Stripe Collections Copilot"}
        </span>
        <a
          href="https://dashboard.stripe.com/apps/com.stripecollectionscopilot.app"
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition-colors"
        >
          Install on Stripe
        </a>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
        <span className="inline-block rounded-full bg-green-100 px-3 py-1 text-sm font-medium text-green-700 mb-6">
          Stripe-native · Zero setup
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
            href="#pricing"
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
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
            Most AI collections tools give you one choice: full auto, or nothing.
          </h2>
          <p className="text-center text-gray-600 max-w-xl mx-auto mb-14">
            That's a hard sell when it's your customers on the other end of the email.
            So we built it differently — you start exactly as hands-on as you want, and
            earn your way to hands-off.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[
              {
                mode: "Draft",
                desc: "Every email is written and queued for your approval. Nothing sends without you. This is where most people start, and it's how you find out what our AI actually sounds like before it ever touches a customer relationship.",
                color: "bg-blue-50 border-blue-200",
              },
              {
                mode: "Semi-Auto",
                desc: "Friendly early reminders (Day 1–3) send automatically. Anything firmer still waits for your sign-off. You stop babysitting the polite nudges, keep control of the harder conversations.",
                color: "bg-amber-50 border-amber-200",
              },
              {
                mode: "Full Auto",
                desc: "The entire sequence runs without you. You're notified when something happens — payment received, sequence escalated — never bothered to make it happen.",
                color: "bg-green-50 border-green-200",
              },
            ].map((tier) => (
              <div
                key={tier.mode}
                className={`rounded-xl border p-6 ${tier.color}`}
              >
                <h3 className="text-lg font-bold text-gray-900">{tier.mode} Mode</h3>
                <p className="mt-2 text-sm text-gray-700 leading-relaxed">
                  {tier.desc}
                </p>
              </div>
            ))}
          </div>
          <p className="text-center text-gray-500 text-sm mt-8">
            Switch modes any time, per-customer if you want. Nothing here is locked in.
          </p>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="max-w-4xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
          Simple pricing
        </h2>
        <p className="text-center text-gray-600 max-w-lg mx-auto mb-14">
          Unlimited invoice sequences on both plans. Upgrade anytime — no contracts,
          cancel in one click.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-2xl mx-auto">
          {[
            {
              name: "Standard",
              price: "$15",
              period: "/month",
              tier: "standard",
              features: [
                "Up to 50 overdue invoices tracked",
                "3-stage escalation ladder",
                "Custom sender branding",
                "Weekly recovery reports",
                "Trust Mode selector",
              ],
              cta: "Subscribe to Standard",
              highlight: false,
            },
            {
              name: "Pro",
              price: "$29",
              period: "/month",
              tier: "pro",
              features: [
                "Everything in Standard",
                "Unlimited overdue invoices",
                "Custom escalation timing",
                "Late-fee automation",
                "Priority support",
              ],
              cta: "Subscribe to Pro",
              highlight: true,
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
              <p className="mt-4">
                <span className="text-4xl font-bold text-gray-900">
                  {plan.price}
                </span>
                <span className="text-gray-500">{plan.period}</span>
              </p>
              <ul className="mt-6 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-green-500 mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
              <SubscribeButton tier={plan.tier} label={plan.cta} highlight={plan.highlight} />
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
            Connect your Stripe account and let Stripe Collections Copilot handle the
            follow-ups. Polite, personalized, and persistent — without you lifting a
            finger.
          </p>
          <a
            href="#pricing"
            className="inline-block rounded-lg bg-indigo-600 px-6 py-3 text-base font-semibold text-white hover:bg-indigo-700 transition-colors"
          >
            View plans →
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
          <a
            href="mailto:stripecopilot@outlook.com"
            className="hover:text-gray-700 transition-colors"
          >
stripecopilot@outlook.com
          </a>
        </div>
        <p>
          {businessName || "Stripe Collections Copilot"} · Built on{" "}
          <a
            href="https://cto.new"
            className="underline hover:text-gray-700"
          >
            cto.new
          </a>
        </p>
      </footer>
    </div>
  );
}

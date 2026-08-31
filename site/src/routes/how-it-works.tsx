import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";

export const Route = createFileRoute("/how-it-works")({
  component: HowItWorks,
});

function HowItWorks() {
  return (
    <div className="min-h-dvh">
      <SiteNav />

      {/* Intro */}
      <section className="max-w-5xl mx-auto px-6 pt-14 pb-4 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          How it works
        </h1>
        <p className="mt-4 text-gray-600 max-w-2xl mx-auto leading-relaxed">
          Unlike other tools, we give you control from day one — you start exactly as
          hands-on as you want, and earn your way to hands-off. Here's what every
          sequence and mode does.
        </p>
      </section>

      {/* Full 3-stage escalation detail */}
      <section className="max-w-5xl mx-auto px-6 py-14">
        <h2 className="text-2xl font-bold text-center text-gray-900 mb-2">
          Every sequence escalates in three stages
        </h2>
        <p className="text-center text-gray-600 max-w-xl mx-auto mb-8 leading-relaxed">
          Two or three gentle, personalized emails — drafted and sent automatically on a
          schedule you control. They read like you, because they're from you.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Stage 1 — sent automatically */}
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                Y
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  You &lt;you@yourbusiness.com&gt;
                </p>
                <p className="text-xs text-gray-500">Sent automatically · Day 1–6</p>
              </div>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                Subject
              </p>
              <p className="text-sm font-semibold text-gray-900">
                Quick nudge — invoice #1042
              </p>
              <p className="mt-2 text-sm text-gray-700 leading-relaxed">
                “Hey Sarah, just a heads-up that invoice #1042 passed its due date — no
                rush if it slipped your mind.”
              </p>
            </div>
          </div>
          {/* Stage 2 — waits for approval */}
          <div className="overflow-hidden rounded-2xl border border-indigo-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-indigo-100 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                Y
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  You &lt;you@yourbusiness.com&gt;
                </p>
                <p className="text-xs text-indigo-600">Waits for your approval · Day 7–20</p>
              </div>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                Subject
              </p>
              <p className="text-sm font-semibold text-gray-900">
                Following up — invoice #1042
              </p>
              <p className="mt-2 text-sm text-gray-700 leading-relaxed">
                “Following up on invoice #1042 ($450, due last month). It's now 12 days
                past due — is anything blocking payment on your end?”
              </p>
            </div>
          </div>
          {/* Stage 3 — waits for approval */}
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                Y
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  You &lt;you@yourbusiness.com&gt;
                </p>
                <p className="text-xs text-gray-500">Waits for your approval · Day 21+</p>
              </div>
            </div>
            <div className="px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                Subject
              </p>
              <p className="text-sm font-semibold text-gray-900">
                Final notice — invoice #1042
              </p>
              <p className="mt-2 text-sm text-gray-700 leading-relaxed">
                “Final notice before further follow-up. Please settle invoice #1042 at your
                earliest convenience.”
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Mode comparison + payment stop */}
      <section className="bg-gray-50 py-16">
        <div className="max-w-5xl mx-auto px-6">
          {/* What each mode sends, per stage */}
          <h2 className="text-2xl font-bold text-center text-gray-900 mb-2">
            What each mode sends, per stage
          </h2>
          <p className="text-center text-gray-600 max-w-xl mx-auto mb-8 leading-relaxed">
            Pick how much autonomy you're comfortable with — and change it any time,
            per-customer if you want. Nothing here is locked in.
          </p>
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
        </div>
      </section>

      {/* Not another tool to manage */}
      <section className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center text-gray-900 mb-6">
          Not another tool to manage
        </h2>
        <p className="text-center text-gray-600 max-w-3xl mx-auto mb-8 leading-relaxed">
          Most collections apps ask you to sign up somewhere new, connect your invoices
          to their system, and hope they treat your client data carefully. CollectionsCopilot
          is a Stripe App — it runs on the invoices already in your Stripe account. Nothing
          to export, nothing to sync, one dashboard.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <p className="text-sm text-gray-700 leading-relaxed">
              <span className="font-semibold text-gray-900">Read-only by default.</span>{" "}
              We can't touch your invoices, customers, or payment methods — ever.
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <p className="text-sm text-gray-700 leading-relaxed">
              <span className="font-semibold text-gray-900">You choose the level of trust.</span>{" "}
              Start in Draft Mode and approve every email. Move to Semi-Auto when you trust
              the friendly ones. Go Full Auto only when you're ready — per customer, any time.
            </p>
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <p className="text-sm text-gray-700 leading-relaxed">
              <span className="font-semibold text-gray-900">Disconnect in one click,</span>{" "}
              from the Stripe Dashboard itself — not a support ticket.
            </p>
          </div>
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
            Your first month is free — full access, no card required. After that,
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

      <SiteFooter />
    </div>
  );
}

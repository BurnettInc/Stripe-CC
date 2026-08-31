import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import { SiteCTA } from "../components/SiteCTA";
import {
  CARD,
  CALLOUT_INDIGO,
  PY_MAIN,
  PY_RELATED,
  STATUS_AUTO,
  STATUS_AUTO_ROW,
  STATUS_WAIT,
  TYPE,
} from "../components/ui";

export const Route = createFileRoute("/how-it-works")({
  component: HowItWorks,
});

function HowItWorks() {
  return (
    <div className="min-h-dvh">
      <SiteNav />

      {/* Intro */}
      <section className="max-w-5xl mx-auto px-6 pt-14 pb-4 text-center">
        <h1 className={TYPE.pageTitle}>How it works</h1>
        <p className={`mt-4 text-gray-600 max-w-2xl mx-auto ${TYPE.bodyLg}`}>
          Unlike other tools, we give you control from day one — you start exactly
          as hands-on as you want, and earn your way to hands-off. Here's what every
          sequence and mode does.
        </p>
      </section>

      {/* Full 3-stage escalation detail */}
      <section className={`max-w-5xl mx-auto px-6 ${PY_RELATED}`}>
        <h2 className={TYPE.h2Center}>Every sequence escalates in three stages</h2>
        <p className={`text-center text-gray-600 max-w-xl mx-auto ${TYPE.bodyLg}`}>
          Two or three gentle, personalized emails — drafted and sent automatically
          on a schedule you control. They read like you, because they're from you.
        </p>
        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Stage 1 — sent automatically */}
          <div className={`overflow-hidden ${CARD}`}>
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                A
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  Alex at ACME Services
                </p>
                <p className={`text-xs ${STATUS_AUTO}`}>Sent automatically · Day 1–6</p>
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
                “Hey Sarah, just a heads-up that invoice #1042 passed its due date —
                no rush if it slipped your mind.”
              </p>
            </div>
          </div>
          {/* Stage 2 — waits for approval */}
          <div className={`overflow-hidden ${CARD}`}>
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                A
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  Alex at ACME Services
                </p>
                <p className={`text-xs ${STATUS_WAIT}`}>
                  Waits for your approval · Day 7–20
                </p>
              </div>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                Subject
              </p>
              <p className="text-sm font-semibold text-gray-900">
                Following up — invoice #1042
              </p>
              <p className="mt-2 text-sm text-gray-700 leading-relaxed">
                “Following up on invoice #1042 ($450, due last month). It's now 12
                days past due — is anything blocking payment on your end?”
              </p>
            </div>
          </div>
          {/* Stage 3 — waits for approval */}
          <div className={`overflow-hidden ${CARD}`}>
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                A
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  Alex at ACME Services
                </p>
                <p className={`text-xs ${STATUS_WAIT}`}>
                  Waits for your approval · Day 21+
                </p>
              </div>
            </div>
            <div className="px-5 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                Subject
              </p>
              <p className="text-sm font-semibold text-gray-900">
                Final notice — invoice #1042
              </p>
              <p className="mt-2 text-sm text-gray-700 leading-relaxed">
                “Final notice before further follow-up. Please settle invoice #1042
                at your earliest convenience.”
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Mode comparison + payment stop */}
      <section className={`bg-gray-50 ${PY_MAIN}`}>
        <div className="max-w-5xl mx-auto px-6">
          {/* What each mode sends, per stage */}
          <h2 className={TYPE.h2Center}>What each mode sends, per stage</h2>
          <p className={`text-center text-gray-600 max-w-xl mx-auto ${TYPE.bodyLg}`}>
            Pick how much autonomy you're comfortable with — and change it any time,
            per-customer if you want. Nothing here is locked in.
          </p>
          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            {[
              {
                mode: "Draft",
                tagline: "You approve everything",
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
                behavior: [
                  { when: "Day 1–6", action: "Auto-sends", auto: true },
                  { when: "Day 7–20", action: "Auto-sends", auto: true },
                  { when: "Day 21+", action: "Auto-sends", auto: true },
                ],
                note: "The whole sequence runs without you. You're notified when something happens — payment received, sequence escalated — never bothered to make it happen.",
              },
            ].map((mode) => (
              <div key={mode.mode} className={`flex flex-col ${CARD} p-6`}>
                <h3 className={TYPE.h3}>{mode.mode} Mode</h3>
                <p className="mt-1 text-xs font-medium text-gray-500">{mode.tagline}</p>
                <ul className="mt-4 space-y-2">
                  {mode.behavior.map((b) => (
                    <li
                      key={b.when}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <span className="font-medium text-gray-700 shrink-0">{b.when}</span>
                      <span
                        className={
                          b.auto ? `${STATUS_AUTO_ROW} text-right` : `${STATUS_WAIT} text-right`
                        }
                      >
                        {b.auto ? "✓ " : ""}
                        {b.action}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-sm text-gray-700 leading-relaxed">{mode.note}</p>
              </div>
            ))}
          </div>

          {/* Payment stop guarantee */}
          <div className={`${CALLOUT_INDIGO} text-center mb-6`}>
            <p className="text-base font-semibold text-indigo-900">
              The moment a payment is detected, the entire sequence stops — no
              exceptions.
            </p>
            <p className="mt-1 text-sm text-indigo-700">
              Before every send, the pipeline re-checks the invoice. Paid? That
              customer's sequence is done.
            </p>
          </div>
        </div>
      </section>

      {/* Trust pointer (full detail lives on /trust) */}
      <section className={`max-w-4xl mx-auto px-6 ${PY_MAIN} text-center`}>
        <p className={TYPE.body}>
          Curious about permissions and data access?{" "}
          <a href="/trust" className="text-indigo-600 underline">
            See Trust &amp; Security →
          </a>
        </p>
      </section>

      <SiteCTA />

      <SiteFooter />
    </div>
  );
}

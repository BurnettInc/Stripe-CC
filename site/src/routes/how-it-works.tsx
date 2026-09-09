import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import { SiteCTA } from "../components/SiteCTA";
import {
  CARD,
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

/* Small arrow separator for connected flows: horizontal on desktop,
 * vertical on mobile. Decorative only. */
function FlowArrow() {
  return (
    <>
      <span aria-hidden="true" className="hidden shrink-0 self-center text-xl text-muted md:inline">
        →
      </span>
      <span aria-hidden="true" className="shrink-0 self-center text-xl text-muted md:hidden">
        ↓
      </span>
    </>
  );
}

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

      {/* Sequence strip: the escalation timeline at a glance */}
      <section className={`max-w-5xl mx-auto px-6 ${PY_RELATED}`}>
        <div className="flex flex-col items-stretch justify-center gap-2 md:flex-row md:items-stretch">
          <div className="rounded-[14px] border border-hairline bg-warn-bg px-5 py-4 text-center shadow-sm md:flex-1">
            <p className="text-sm font-semibold text-ink">$450 invoice overdue</p>
            <p className="mt-1 text-[13px] text-muted">Copilot notices, instantly</p>
          </div>
          <FlowArrow />
          <div className={`px-5 py-4 text-center md:flex-1 ${CARD}`}>
            <p className="text-sm font-semibold text-ink">Day 1: friendly reminder</p>
            <p className="mt-1 text-[13px] text-muted">A gentle nudge, in your voice</p>
          </div>
          <FlowArrow />
          <div className={`px-5 py-4 text-center md:flex-1 ${CARD}`}>
            <p className="text-sm font-semibold text-ink">Day 7: follow-up</p>
            <p className="mt-1 text-[13px] text-muted">Firmer, still polite</p>
          </div>
          <FlowArrow />
          <div className={`px-5 py-4 text-center md:flex-1 ${CARD}`}>
            <p className="text-sm font-semibold text-ink">Day 21: final notice</p>
            <p className="mt-1 text-[13px] text-muted">Your last word before you step in</p>
          </div>
          <FlowArrow />
          <div className="rounded-[14px] border border-hairline bg-success-bg px-5 py-4 text-center shadow-sm md:flex-1">
            <p className="text-sm font-semibold text-success-text">
              <span aria-hidden="true">✓ </span>Customer paid — sequence stops
            </p>
            <p className="mt-1 text-[13px] text-success-text">
              Automatically, mid-sequence
            </p>
          </div>
        </div>
      </section>

      {/* Full 3-stage escalation detail */}
      <section className={`max-w-5xl mx-auto px-6 ${PY_RELATED}`}>
        <h2 className={TYPE.h2Center}>Every unpaid invoice escalates in three stages</h2>
        <p className={`text-center text-gray-600 max-w-xl mx-auto ${TYPE.bodyLg}`}>
          Two or three gentle, personalized emails — drafted and sent automatically
          on a schedule you control. They read like you, because they're from you.
        </p>
        <div className="mt-8 flex flex-col items-stretch gap-2 md:flex-row">
          {/* Stage 1 — sent automatically */}
          <div className={`overflow-hidden md:flex-1 ${CARD}`}>
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                A
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  Alex at ACME Services
                </p>
                <p className={`text-xs ${STATUS_AUTO}`}>AUTO-SENT · Day 1–6</p>
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
          <FlowArrow />
          {/* Stage 2 — waits for approval */}
          <div className={`overflow-hidden md:flex-1 ${CARD}`}>
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                A
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  Alex at ACME Services
                </p>
                <p className={`text-xs ${STATUS_WAIT}`}>
                  APPROVAL REQUIRED · Day 7–20
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
          <FlowArrow />
          {/* Stage 3 — waits for approval */}
          <div className={`overflow-hidden md:flex-1 ${CARD}`}>
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                A
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">
                  Alex at ACME Services
                </p>
                <p className={`text-xs ${STATUS_WAIT}`}>
                  APPROVAL REQUIRED · Day 21+
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
        <p className={`mt-6 text-center text-base font-medium ${STATUS_AUTO}`}>
          💰 Customer pays — sequence stops automatically
        </p>
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
                mode: "Draft Mode",
                cue: "You approve",
                tagline: "Nothing sends without you",
                behavior: [
                  { when: "Day 1–6", action: "Drafted & queued for your approval", auto: false },
                  { when: "Day 7–20", action: "Drafted & queued for your approval", auto: false },
                  { when: "Day 21+", action: "Drafted & queued for your approval", auto: false },
                ],
                note: "Every email is drafted and queued for your approval. Nothing sends without you — ever.",
              },
              {
                mode: "Semi-Auto",
                cue: "Shared control",
                tagline: "Friendly reminders send themselves",
                behavior: [
                  { when: "Day 1–6", action: "Auto-sends", auto: true },
                  { when: "Day 7–20", action: "Waits for your approval", auto: false },
                  { when: "Day 21+", action: "Waits for your approval", auto: false },
                ],
                note: "Stage 1 friendly reminders run on their own. Stages 2–3 still wait for your sign-off.",
              },
              {
                mode: "Copilot Mode",
                cue: "Copilot handles it",
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
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                  {mode.cue}
                </p>
                <h3 className={`mt-1 ${TYPE.h3}`}>{mode.mode}</h3>
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

          {/* Payment-stop closer */}
          <div className="rounded-[14px] border border-hairline bg-success-bg p-8 sm:p-12 text-center mb-6">
            <p className="font-display text-[28px] sm:text-[36px] font-semibold tracking-[-0.01em] text-ink">
              <span aria-hidden="true" className="text-success-text">✓ </span>
              Customer paid? We&rsquo;re done.
            </p>
            <p className="mt-3 text-base text-muted max-w-xl mx-auto leading-relaxed">
              Before every send, the pipeline re-checks the invoice. Paid? That
              customer&rsquo;s sequence is done — no exceptions, no awkward
              follow-ups.
            </p>
          </div>
        </div>
      </section>

      {/* Stripe flow: Copilot never moves money */}
      <section className={`max-w-5xl mx-auto px-6 ${PY_MAIN}`}>
        <h2 className={TYPE.h2Center}>Copilot never moves money. Stripe does.</h2>
        <p className={`text-center text-gray-600 max-w-xl mx-auto ${TYPE.bodyLg}`}>
          Copilot only reads invoice data and sends reminders — it never touches
          funds. Payment always settles in Stripe, exactly as it does today.
        </p>
        <div className="mt-8 flex flex-col items-stretch gap-2 md:flex-row md:items-stretch">
          <div className={`px-5 py-4 text-center md:flex-1 ${CARD}`}>
            <p className="text-sm font-semibold text-ink">Your Stripe account</p>
            <p className="mt-1 text-[13px] text-muted">
              Invoice data in — Copilot reads what&rsquo;s overdue
            </p>
          </div>
          <FlowArrow />
          <div className={`px-5 py-4 text-center md:flex-1 ${CARD}`}>
            <p className="text-sm font-semibold text-ink">Collections Copilot</p>
            <p className="mt-1 text-[13px] text-muted">
              Reminders out — personalized emails to your customer
            </p>
          </div>
          <FlowArrow />
          <div className={`px-5 py-4 text-center md:flex-1 ${CARD}`}>
            <p className="text-sm font-semibold text-ink">Your customer</p>
            <p className="mt-1 text-[13px] text-muted">
              Pays via Stripe — funds settle straight to you
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

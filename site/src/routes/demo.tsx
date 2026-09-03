import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  CALLOUT_AMBER,
  PY_MAIN,
  STATUS_AUTO,
  STATUS_WAIT,
  TYPE,
} from "../components/ui";

export const Route = createFileRoute("/demo")({
  component: Demo,
});

/* ------------------------------------------------------------------ *
 *  Public read-only demo — 100% fictional sample data.
 *  No Stripe connection, no database, no real emails. Refreshing the
 *  page resets everything to this seed state.
 * ------------------------------------------------------------------ */

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";
const SIGNUP_URL = `${INSTALL_URL}?utm_source=demo`;

type PipeStage = "watch" | "draft" | "review" | "send";
type TrustMode = "draftOnly" | "semiAuto" | "fullAuto";

type Draft = {
  stage: 1 | 2 | 3;
  subject: string;
  body: string[];
};

type SentEmail = {
  stage: 1 | 2 | 3;
  subject: string;
  sentLabel: string;
  snippet: string;
};

type Invoice = {
  id: string;
  customer: string;
  company: string;
  amount: number;
  daysOverdue: number;
  pipe: PipeStage;
  draft?: Draft;
  sent?: SentEmail[];
  note?: string;
};

/* All names, companies, invoices, and amounts below are fictional. */
const SEED: Invoice[] = [
  {
    id: "inv_1041",
    customer: "Avery Chen",
    company: "Chen Studio",
    amount: 450,
    daysOverdue: 5,
    pipe: "watch",
    draft: {
      stage: 1,
      subject: "Quick heads-up — invoice #1041",
      body: [
        "Hi Avery,",
        "Hope the week's going well. Quick heads-up that invoice #1041 ($450) passed its due date a few days ago — no rush at all if it just slipped your mind.",
        "If anything looks off, just reply and I'll sort it out.",
      ],
    },
  },
  {
    id: "inv_1060",
    customer: "Leo Fischer",
    company: "Fischer Studio",
    amount: 720,
    daysOverdue: 3,
    pipe: "watch",
    draft: {
      stage: 1,
      subject: "Quick heads-up — invoice #1060",
      body: [
        "Hi Leo,",
        "Just a friendly heads-up that invoice #1060 ($720) is a few days past due — no urgency, just wanted to make sure it's on your radar.",
        "Let me know if the date needs to shift.",
      ],
    },
  },
  {
    id: "inv_1053",
    customer: "Marcus Webb",
    company: "Webb Digital",
    amount: 1250,
    daysOverdue: 6,
    pipe: "draft",
    draft: {
      stage: 1,
      subject: "Quick nudge — invoice #1053",
      body: [
        "Hi Marcus,",
        "Hope the site relaunch went well this week. Just a quick nudge that invoice #1053 ($1,250) slipped past its due date — no rush if it's been a busy one.",
        "If it's already on its way, no need to reply. Cheers!",
      ],
    },
  },
  {
    id: "inv_1062",
    customer: "Sofia Reyes",
    company: "Reyes Collective",
    amount: 640,
    daysOverdue: 9,
    pipe: "draft",
    draft: {
      stage: 2,
      subject: "Following up — invoice #1062",
      body: [
        "Hi Sofia,",
        "Following up on invoice #1062 ($640) — it's now a few days past due. If it's already on its way, you can ignore this; if there's a hiccup on your end, happy to work something out.",
        "Let me know either way?",
      ],
    },
  },
  {
    id: "inv_1047",
    customer: "Priya Natarajan",
    company: "Natarajan Design",
    amount: 2800,
    daysOverdue: 18,
    pipe: "draft",
    draft: {
      stage: 2,
      subject: "Overdue — invoice #1047",
      body: [
        "Hi Priya,",
        "I wanted to check in personally about invoice #1047 ($2,800), which is now 18 days past its due date. We're past the friendly-reminder stage, so I'd really appreciate it if you could arrange payment this week.",
        "If there's a billing question or a specific blocker, reply and I'll sort it out right away — otherwise our standard reminders will keep running.",
      ],
    },
  },
  {
    id: "inv_1039",
    customer: "Elena Petrova",
    company: "Petrova Creative",
    amount: 1980,
    daysOverdue: 34,
    pipe: "review",
    draft: {
      stage: 3,
      subject: "Final notice — invoice #1039",
      body: [
        "Hi Elena,",
        "This is the final notice for invoice #1039 ($1,980), now 34 days overdue. Two reminders have gone out with no payment received, and per our payment terms this invoice needs to be settled without further delay.",
        "Please arrange payment now — and if there's a dispute or a hardship, contact us today so we can find a solution before any further steps are taken.",
      ],
    },
  },
  {
    id: "inv_1058",
    customer: "James Okafor",
    company: "Okafor Consulting",
    amount: 3400,
    daysOverdue: 47,
    pipe: "review",
    draft: {
      stage: 3,
      subject: "Final notice before escalation — invoice #1058",
      body: [
        "Hi James,",
        "Invoice #1058 ($3,400) is now 47 days overdue. Our earlier reminders have gone unanswered, and this is the final notice before we consider next steps under our payment terms, including pausing future work.",
        "If this was an oversight, one quick payment settles it. If there's a reason, reply today — we'd much rather sort it out than escalate it.",
      ],
    },
  },
  {
    id: "inv_1044",
    customer: "Maya Thompson",
    company: "Thompson & Lane",
    amount: 150,
    daysOverdue: 20,
    pipe: "send",
    sent: [
      {
        stage: 2,
        subject: "Following up — invoice #1044",
        sentLabel: "Sent 3 days ago (demo)",
        snippet: "“Following up on invoice #1044 ($150) — it's now a few days past its due date…”",
      },
    ],
    draft: {
      stage: 3,
      subject: "Final notice — invoice #1044",
      body: [
        "Hi Maya,",
        "This is the final notice for invoice #1044 ($150), now 20 days overdue. Our earlier follow-up has not been answered, so please settle this invoice at your earliest convenience.",
        "If you've already paid — thank you, and please ignore this note.",
      ],
    },
    note: "Stage 2 sent · Stage 3 final notice queued for day 21+",
  },
  {
    id: "inv_1055",
    customer: "Daniel Kim",
    company: "Kim Digital",
    amount: 4500,
    daysOverdue: 62,
    pipe: "send",
    sent: [
      {
        stage: 1,
        subject: "Quick nudge — invoice #1055",
        sentLabel: "Sent 41 days ago (demo)",
        snippet: "“Just a quick nudge that invoice #1055 ($4,500) passed its due date…”",
      },
      {
        stage: 2,
        subject: "Following up — invoice #1055",
        sentLabel: "Sent 28 days ago (demo)",
        snippet: "“Following up on invoice #1055 ($4,500) — it's now past due…”",
      },
      {
        stage: 3,
        subject: "Final notice — invoice #1055",
        sentLabel: "Sent 14 days ago (demo)",
        snippet: "“This is the final notice for invoice #1055 ($4,500), now 48 days overdue…”",
      },
    ],
    note: "Full 3-stage sequence sent · waiting on payment",
  },
];

const MODES: { id: TrustMode; label: string; blurb: string }[] = [
  {
    id: "draftOnly",
    label: "Draft Only",
    blurb: "You approve everything — every reminder is drafted and queued for your sign-off. Nothing sends without you, ever.",
  },
  {
    id: "semiAuto",
    label: "Semi-Auto",
    blurb: "Stage 1 friendly nudges send themselves. Stages 2 and 3 still wait for your approval.",
  },
  {
    id: "fullAuto",
    label: "Full Auto",
    blurb: "The whole sequence runs on its own. You're notified when something happens — payment received, sequence escalated — never asked to make it happen.",
  },
];

const PIPE_META: Record<
  PipeStage,
  { label: string; hint: (m: TrustMode) => string; accent: string }
> = {
  watch: {
    label: "Watch",
    hint: () => "Newly overdue — the AI drafts the Stage 1 nudge at day 6",
    accent: "text-gray-600",
  },
  draft: {
    label: "Draft",
    hint: (m) =>
      m === "fullAuto"
        ? "Drafts auto-send on schedule"
        : m === "semiAuto"
          ? "Stage 1 auto-sends · Stages 2–3 wait for you"
          : "AI-drafted · queued for your approval",
    accent: "text-indigo-700",
  },
  review: {
    label: "Review",
    hint: (m) =>
      m === "fullAuto" ? "21+ day drafts auto-send" : "21+ day drafts waiting for your sign-off",
    accent: "text-amber-700",
  },
  send: {
    label: "Send",
    hint: () => "Reminders already sent · watching for payment",
    accent: "text-green-700",
  },
};

function money(n: number) {
  return `$${n.toLocaleString("en-US")}`;
}

function daysLabel(d: number) {
  return `${d} day${d === 1 ? "" : "s"} overdue`;
}

function stageChip(inv: Invoice, mode: TrustMode): { text: string; cls: string } {
  if (inv.pipe === "send") {
    const last = inv.sent?.[inv.sent.length - 1];
    if (!last) return { text: "Sent · waiting on payment", cls: STATUS_AUTO };
    return {
      text: `${last.stage === 3 ? "Final notice" : `Stage ${last.stage} reminder`} sent · waiting on payment`,
      cls: STATUS_AUTO,
    };
  }
  if (inv.pipe === "watch") {
    return { text: "Not drafted yet · AI drafts at day 6", cls: STATUS_WAIT };
  }
  // draft / review
  if (inv.draft?.stage === 1) {
    return mode === "draftOnly"
      ? { text: "Drafted · waiting for you", cls: STATUS_WAIT }
      : { text: "✓ Auto-sends (Stage 1)", cls: STATUS_AUTO };
  }
  return mode === "fullAuto"
    ? { text: "✓ Auto-sends", cls: STATUS_AUTO }
    : { text: "Drafted · waiting for you", cls: STATUS_WAIT };
}

function Demo() {
  const [invoices, setInvoices] = useState<Invoice[]>(SEED);
  const [mode, setMode] = useState<TrustMode>("semiAuto");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [justAdvanced, setJustAdvanced] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const selected = invoices.find((i) => i.id === selectedId) ?? null;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!justAdvanced) return;
    const t = setTimeout(() => setJustAdvanced(null), 4000);
    return () => clearTimeout(t);
  }, [justAdvanced]);

  function advance(inv: Invoice) {
    if (inv.pipe === "watch") {
      setInvoices((prev) =>
        prev.map((i) => (i.id === inv.id ? { ...i, pipe: "draft" as PipeStage } : i)),
      );
      setJustAdvanced(inv.id);
      setToast("Demo: AI just drafted the Stage 1 nudge for " + inv.customer + ".");
    } else if (inv.pipe === "draft" || inv.pipe === "review") {
      setInvoices((prev) =>
        prev.map((i) =>
          i.id === inv.id
            ? {
                ...i,
                pipe: "send" as PipeStage,
                sent: [
                  ...(i.sent ?? []),
                  {
                    stage: (i.draft?.stage ?? 1) as 1 | 2 | 3,
                    subject: i.draft?.subject ?? "",
                    sentLabel: "Sent just now (demo)",
                    snippet: i.draft?.body[0] ?? "",
                  },
                ],
              }
            : i,
        ),
      );
      setJustAdvanced(inv.id);
      setToast(
        mode === "fullAuto"
          ? "Demo (Full Auto): reminder sent automatically for " + inv.customer + "."
          : "Demo: reminder approved & sent for " + inv.customer + ".",
      );
    }
  }

  function resetDemo() {
    setInvoices(SEED);
    setSelectedId(null);
    setJustAdvanced(null);
    setToast("Demo reset — back to the sample account.");
  }

  const byPipe = (p: PipeStage) => invoices.filter((i) => i.pipe === p);

  return (
    <div className="min-h-dvh pb-28">
      <SiteNav />

      {/* Persistent demo-mode banner */}
      <div className="sticky top-0 z-40 border-b border-amber-200 bg-amber-50/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-amber-900">
            Demo Mode — sample data, no real invoices or emails
          </p>
          <button
            onClick={resetDemo}
            className="text-xs font-medium text-amber-800 underline hover:text-amber-900 transition-colors"
          >
            Reset demo
          </button>
        </div>
      </div>

      {/* Intro */}
      <section className="max-w-6xl mx-auto px-6 pt-12 pb-6 text-center">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-indigo-600">
          Live demo · fictional account
        </p>
        <h1 className={TYPE.pageTitle}>See the collections pipeline in action</h1>
        <p className={`mt-4 text-gray-600 max-w-2xl mx-auto ${TYPE.bodyLg}`}>
          This is what an overdue-invoice queue looks like inside Collections
          Copilot. Every customer, invoice, and email below is made-up sample data —
          nothing here is real, nothing sends, and nothing is saved. Click an
          invoice to open it, then try the Trust Mode toggle to see how each mode
          behaves.
        </p>
      </section>

      {/* Trust Mode selector */}
      <section className="max-w-6xl mx-auto px-6 pb-8">
        <h2 className={TYPE.h2}>Trust Mode</h2>
        <p className="mt-1 text-sm text-gray-500">
          How much autonomy would you hand off? Pick a mode and watch the pipeline
          adjust.
        </p>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          {MODES.map((m) => {
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                aria-pressed={active}
                className={`text-left flex flex-col ${CARD} p-5 transition-all ${
                  active ? "border-indigo-300 ring-2 ring-indigo-600" : "hover:border-gray-300"
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className={`${TYPE.h3} ${active ? "text-indigo-700" : ""}`}>
                    {m.label}
                  </span>
                  <span
                    className={`h-4 w-4 rounded-full border ${
                      active
                        ? "border-indigo-600 bg-indigo-600"
                        : "border-gray-300 bg-white"
                    }`}
                  />
                </span>
                <span className="mt-2 text-sm text-gray-600 leading-relaxed">{m.blurb}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Pipeline board */}
      <section className="max-w-6xl mx-auto px-6">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
          {(["watch", "draft", "review", "send"] as PipeStage[]).map((p) => {
            const meta = PIPE_META[p];
            const items = byPipe(p);
            return (
              <div key={p} className={`flex flex-col ${CARD} overflow-hidden`}>
                <div className="border-b border-gray-100 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <h3 className={`text-base font-bold ${meta.accent}`}>{meta.label}</h3>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {items.length}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 leading-relaxed">{meta.hint(mode)}</p>
                </div>
                <div className="flex flex-1 flex-col gap-3 p-3">
                  {items.length === 0 && (
                    <p className="px-2 py-6 text-center text-xs text-gray-400">
                      Nothing here right now
                    </p>
                  )}
                  {items.map((inv) => {
                    const chip = stageChip(inv, mode);
                    const advanced = justAdvanced === inv.id;
                    return (
                      <button
                        key={inv.id}
                        onClick={() => setSelectedId(inv.id)}
                        className={`text-left flex flex-col ${CARD_BASE_LOCAL} border border-gray-200 p-4 transition-colors hover:border-indigo-300 ${
                          advanced ? "ring-2 ring-green-400" : ""
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-gray-900">
                              {inv.customer}
                            </p>
                            <p className="truncate text-xs text-gray-500">{inv.company}</p>
                          </div>
                          <span className="shrink-0 text-sm font-bold text-gray-900">
                            {money(inv.amount)}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-gray-500">
                          {inv.id} · {daysLabel(inv.daysOverdue)}
                        </p>
                        <p className={`mt-1 text-xs font-medium ${chip.cls}`}>
                          {advanced ? "✓ Advanced (demo)" : chip.text}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-4 text-xs text-gray-400 text-center">
          Click any invoice to open it and read the AI-drafted email. Refresh the
          page to reset the demo.
        </p>
      </section>

      {/* End-of-flow CTA */}
      <section className={`max-w-4xl mx-auto px-6 ${PY_MAIN}`}>
        <div className={`${CALLOUT_AMBER} text-center`}>
          <h2 className={TYPE.h2}>Like what you see?</h2>
          <p className="mt-2 text-gray-700 leading-relaxed max-w-xl mx-auto">
            Connect your real Stripe account in about a minute — read-only at
            first, and your first month is free. Draft Mode stays free forever.
          </p>
          <a
            href={SIGNUP_URL}
            className={`mt-5 ${BTN_PRIMARY}`}
            style={{ display: "inline-flex" }}
          >
            Connect your Stripe account to start free
          </a>
          <p className="mt-3 text-xs text-gray-500">
            No card required · cancel anytime · nothing sends without your approval
          </p>
        </div>
      </section>

      <SiteFooter />

      {/* Sticky conversion CTA */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-800 bg-gray-900/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold text-white">
            Like what you see?{" "}
            <span className="font-normal text-gray-300">
              Connect your Stripe account to start free.
            </span>
          </p>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs text-gray-400">
              First month free · no card required
            </span>
            <a href={SIGNUP_URL} className={BTN_SECONDARY}>
              Start free — connect Stripe
            </a>
          </div>
        </div>
      </div>

      {/* Invoice / email detail modal */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/60 p-4"
          onClick={() => setSelectedId(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Invoice ${selected.id} — ${selected.customer}`}
            className={`w-full max-w-lg max-h-[90vh] overflow-y-auto ${CARD}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4">
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                  {selected.id} · {daysLabel(selected.daysOverdue)}
                </p>
                <h3 className="mt-0.5 truncate text-lg font-bold text-gray-900">
                  {selected.customer} — {selected.company}
                </h3>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                aria-label="Close"
                className="shrink-0 rounded-full border border-gray-200 px-2.5 py-1 text-sm text-gray-500 hover:bg-gray-50"
              >
                ✕
              </button>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold text-gray-900">
                  {money(selected.amount)}
                </span>
                <span className={`text-xs font-medium ${stageChip(selected, mode).cls}`}>
                  {stageChip(selected, mode).text}
                </span>
              </div>
              {selected.note && (
                <p className="mt-1 text-xs text-gray-500">{selected.note}</p>
              )}

              {/* Sent timeline */}
              {selected.sent && selected.sent.length > 0 && (
                <div className="mt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">
                    Already sent
                  </p>
                  <div className="space-y-2">
                    {selected.sent.map((s, i) => (
                      <div key={i} className={`${CARD_BASE_LOCAL} border border-gray-100 bg-gray-50 px-4 py-3`}>
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-semibold text-gray-900">{s.subject}</p>
                          <span className={`text-xs shrink-0 ${STATUS_AUTO}`}>{s.sentLabel}</span>
                        </div>
                        <p className="mt-1 text-xs text-gray-500 leading-relaxed">{s.snippet}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Current / next draft */}
              {selected.pipe !== "send" && selected.draft && (
                <div className="mt-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">
                    {selected.pipe === "watch"
                      ? "What AI will draft at day 6 — Stage 1"
                      : `AI draft — ${selected.draft.stage === 1 ? "Stage 1 · polite nudge" : selected.draft.stage === 2 ? "Stage 2 · follow-up" : "Stage 3 · final notice"}`}
                  </p>
                  <div className={`overflow-hidden ${CARD_BASE_LOCAL} ${BORDER_LOCAL}`}>
                    <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
                        Y
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-gray-900">
                          You &lt;you@yourbusiness.com&gt;
                        </p>
                        <p className={`text-xs ${STATUS_AUTO}`}>
                          {selected.draft.stage === 1 ? "Stage 1 · Day 1–6" : selected.draft.stage === 2 ? "Stage 2 · Day 7–20" : "Stage 3 · Day 21+"}
                        </p>
                      </div>
                    </div>
                    <div className="px-4 py-4">
                      <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-1">
                        Subject
                      </p>
                      <p className="text-sm font-semibold text-gray-900">{selected.draft.subject}</p>
                      <div className="mt-2 space-y-2 text-sm text-gray-700 leading-relaxed">
                        {selected.draft.body.map((line, i) => (
                          <p key={i}>{line}</p>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Mode note + action */}
              <div className="mt-5">
                <div className={`${CARD_BASE_LOCAL} border border-indigo-100 bg-indigo-50 px-4 py-3`}>
                  <p className="text-xs font-semibold text-indigo-900 leading-relaxed">
                    {mode === "draftOnly" && "Draft Only: this reminder waits for your approval — nothing sends without you."}
                    {mode === "semiAuto" &&
                      (selected.draft?.stage === 1
                        ? "Semi-Auto: Stage 1 nudges send themselves. Stages 2–3 still wait for you."
                        : "Semi-Auto: this stage waits for your approval.")}
                    {mode === "fullAuto" && "Full Auto: this sends automatically on schedule. You're notified, not asked."}
                  </p>
                </div>
                {selected.pipe === "watch" && (
                  <button onClick={() => advance(selected)} className={`mt-3 w-full ${BTN_PRIMARY}`}>
                    Simulate: draft this nudge now (demo)
                  </button>
                )}
                {selected.pipe === "draft" && (
                  <button onClick={() => advance(selected)} className={`mt-3 w-full ${BTN_PRIMARY}`}>
                    {mode === "fullAuto" ? "Simulate: auto-send (demo)" : "Approve & send reminder (demo)"}
                  </button>
                )}
                {selected.pipe === "review" && (
                  <button onClick={() => advance(selected)} className={`mt-3 w-full ${BTN_PRIMARY}`}>
                    {mode === "fullAuto" ? "Simulate: auto-send (demo)" : "Approve & send final notice (demo)"}
                  </button>
                )}
                {selected.pipe === "send" && (
                  <p className="mt-3 text-center text-xs text-gray-500">
                    Sequence sent — the pipeline now watches for payment. Nothing
                    else goes out unless it escalates.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed inset-x-0 top-16 z-50 flex justify-center px-6">
          <div className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-lg">
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}

/* Local card classes (kept local so the demo file owns its variants). */
const CARD_BASE_LOCAL = "rounded-2xl bg-white shadow-sm";
const BORDER_LOCAL = "border border-gray-200";
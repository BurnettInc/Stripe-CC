import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import { SiteCTA } from "../components/SiteCTA";
import { CARD_BASE, BORDER_DEFAULT, PY_MAIN, TYPE } from "../components/ui";

export const Route = createFileRoute("/faq")({
  component: Faq,
});

const FAQS = [
  {
    q: "Will this sound robotic?",
    a: "No. Each email is either AI-generated using your invoice history and customer context, or uses carefully written fallback templates that vary by stage. The AI is prompted to write like a human who cares about the relationship — never copy-paste, never robotic. Want to hear it before subscribing? Free Draft Mode lets you preview real drafts from your own invoices.",
  },
  {
    q: "Does this work with one-off invoices as well as recurring ones?",
    a: "Yes. Collections Copilot monitors your Stripe invoices regardless of whether they're one-off or subscription-based. If it's overdue in Stripe, we'll help you follow up.",
  },
  {
    q: "What happens if an invoice is disputed, voided, or marked uncollectible?",
    a: "Reminders halt automatically when an invoice is paid, voided, disputed, or marked uncollectible.",
  },
];

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="min-h-dvh">
      <SiteNav />

      <section className={`max-w-4xl mx-auto px-6 ${PY_MAIN}`}>
        <h1 className={`${TYPE.pageTitle} text-center mb-2`}>
          Frequently asked questions
        </h1>
        <p className={`text-center text-gray-600 max-w-xl mx-auto ${TYPE.body}`}>
          The honest answers to the questions we'd ask, if we were you.
        </p>
        <div className="mt-8 space-y-4">
          {FAQS.map((item, i) => {
            const isOpen = open === i;
            return (
              <div
                key={item.q}
                className={`${CARD_BASE} overflow-hidden ${
                  isOpen ? "border border-indigo-200" : BORDER_DEFAULT
                }`}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
                  aria-expanded={isOpen}
                >
                  <h2 className="font-semibold text-gray-900">{item.q}</h2>
                  <span
                    className={`shrink-0 text-lg text-gray-500 transition-transform ${
                      isOpen ? "rotate-45" : ""
                    }`}
                  >
                    +
                  </span>
                </button>
                {isOpen && (
                  <div className="px-6 pb-5">
                    <p className="text-sm text-gray-600 leading-relaxed">
                      {item.a}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <SiteCTA />

      <SiteFooter />
    </div>
  );
}

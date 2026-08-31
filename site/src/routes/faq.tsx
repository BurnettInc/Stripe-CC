import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";

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
    a: "Yes. CollectionsCopilot monitors your Stripe invoices regardless of whether they're one-off or subscription-based. If it's overdue in Stripe, we'll help you follow up.",
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

      <section className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold text-center text-gray-900 mb-2">
          Frequently asked questions
        </h1>
        <p className="text-center text-gray-600 max-w-xl mx-auto mb-8">
          The honest answers to the questions we'd ask, if we were you.
        </p>
        <div className="space-y-4">
          {FAQS.map((item, i) => {
            const isOpen = open === i;
            return (
              <div
                key={item.q}
                className={`rounded-xl border ${isOpen ? "border-indigo-200" : "border-gray-200"} bg-white overflow-hidden`}
              >
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
                  aria-expanded={isOpen}
                >
                  <h2 className="font-semibold text-gray-900">{item.q}</h2>
                  <span className={`shrink-0 text-lg text-gray-500 transition-transform ${isOpen ? "rotate-45" : ""}`}>
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

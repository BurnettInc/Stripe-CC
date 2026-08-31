import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";

export const Route = createFileRoute("/trust")({
  component: Trust,
});

function Trust() {
  return (
    <div className="min-h-dvh">
      <SiteNav />

      <section className="bg-gray-50 py-16">
        <div className="max-w-4xl mx-auto px-6">
          <h1 className="text-3xl font-bold text-center text-gray-900 mb-4">
            Trust &amp; Transparency
          </h1>
          <p className="text-center text-gray-600 max-w-xl mx-auto mb-8">
            You're trusting us with your customers and your cash flow. Here's exactly
            what we ask for — and what we never do.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            {/* Permissions */}
            <div className="rounded-2xl border border-gray-200 bg-white p-8">
              <h2 className="text-lg font-bold text-gray-900">
                Permissions
              </h2>
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
              <h2 className="text-lg font-bold text-gray-900">
                Pause &amp; cancel, any time
              </h2>
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
            <h2 className="text-lg font-bold text-gray-900">
              Not a debt collection service
            </h2>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">
              CollectionsCopilot sends polite, personalized payment reminders — never
              legal threats, never harassment. Our AI is explicitly instructed to
              preserve your customer relationships, not damage them. If you need formal
              debt collection, this isn't the tool for that.
            </p>
          </div>

          {/* Reply handling */}
          <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-8">
            <h2 className="text-lg font-bold text-gray-900">
              What happens if a customer replies?
            </h2>
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

import { createFileRoute } from "@tanstack/react-router";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import { SiteCTA } from "../components/SiteCTA";
import {
  CARD,
  CALLOUT_AMBER,
  Check,
  PY_MAIN,
  TYPE,
} from "../components/ui";

export const Route = createFileRoute("/trust")({
  component: Trust,
});

function Trust() {
  return (
    <div className="min-h-dvh">
      <SiteNav />

      <section className={`bg-gray-50 ${PY_MAIN}`}>
        <div className="max-w-4xl mx-auto px-6">
          <h1 className={`${TYPE.pageTitle} text-center mb-4`}>Trust &amp; Security</h1>
          <p className={`text-center text-gray-600 max-w-xl mx-auto ${TYPE.bodyLg}`}>
            You're trusting us with your customers and your cash flow. Here's exactly
            what we ask for — and what we never do.
          </p>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            {/* Permissions */}
            <div className={`${CARD} p-8`}>
              <h2 className={TYPE.h3}>Permissions</h2>
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
            <div className={`${CARD} p-8`}>
                <h2 className={TYPE.h3}>Pause &amp; cancel, any time</h2>
                <ul className="mt-4 space-y-4 text-sm text-gray-700">
                  <li className="flex items-start gap-3">
                    <Check />
                    <span>
                      <span className="font-semibold text-gray-900">
                        Switch to Draft Mode
                      </span>{" "}
                      and all auto-sending pauses instantly. No emails go out without
                      your approval in Draft mode.
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Check />
                    <span>
                      You can{" "}
                      <span className="font-semibold text-gray-900">
                        disconnect your Stripe account
                      </span>{" "}
                      at any time from the Stripe Dashboard — sequences stop
                      immediately.
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Check />
                    <span>
                      <span className="font-semibold text-gray-900">
                        Paused stays paused.
                      </span>{" "}
                      Nothing auto-resumes. A paused sequence stays off until you
                      switch back or resume it yourself.
                    </span>
                  </li>
                  <li className="flex items-start gap-3">
                    <Check />
                    <span>
                      <span className="font-semibold text-gray-900">
                        Your data is yours.
                      </span>{" "}
                      Request a full copy of your data or a permanent deletion from
                      inside the app — nothing is held hostage after you leave.
                    </span>
                  </li>
                </ul>
            </div>
          </div>

          {/* Not a debt collection service */}
          <div className={`${CARD} p-8`}>
            <h2 className={TYPE.h3}>Not a debt collection service</h2>
            <p className="mt-3 text-sm text-gray-600 leading-relaxed">
              Collections Copilot sends polite, personalized payment reminders — never
              legal threats, never harassment. Our AI is explicitly instructed to
              preserve your customer relationships, not damage them. If you need formal
              debt collection, this isn't the tool for that.
            </p>
          </div>

          {/* Reply handling */}
          <div className={`${CALLOUT_AMBER} mt-8`}>
            <h2 className={TYPE.h3}>What happens if a customer replies?</h2>
            <p className="mt-3 text-sm text-gray-700 leading-relaxed">
              If a customer replies to any reminder, their sequence pauses
              automatically and you're notified immediately — no more reminders go out
              until you resume it. Their message is also forwarded straight to your
              inbox, so you never miss it.
            </p>
          </div>
        </div>
      </section>

      <SiteCTA />

      <SiteFooter />
    </div>
  );
}

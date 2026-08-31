import { BTN_PRIMARY, PY_CTA } from "./ui";

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";

/* Shared closing CTA band — identical across the landing, how-it-works,
 * trust, and FAQ pages so the four pages share one recipe. */
export function SiteCTA() {
  return (
    <section className={`bg-gray-900 ${PY_CTA}`}>
      <div className="max-w-3xl mx-auto px-6 text-center">
        <h2 className="text-3xl font-bold tracking-tight text-white mb-4">
          Ready to stop chasing payments?
        </h2>
        <p className="text-gray-400 max-w-lg mx-auto mb-4">
          Install from the Stripe App Marketplace. Polite, personalized, and
          persistent reminders — without you lifting a finger.
        </p>
        <p className="text-indigo-300 max-w-lg mx-auto mb-8">
          Your first month is free — full access, no card required. After that,
          Draft Mode stays free forever with up to 5 drafts. Subscribe inside
          the app when you're ready for sending.
        </p>
        <div className="flex flex-col items-center gap-4">
          <a href={INSTALL_URL} className={BTN_PRIMARY}>
            Install from the Stripe App Marketplace
          </a>
        </div>
      </div>
    </section>
  );
}

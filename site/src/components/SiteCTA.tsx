import { BTN_PRIMARY, PY_CTA } from "./ui";

const INSTALL_URL =
  "https://marketplace.stripe.com/apps/install/link/com.stripecollectionscopilot.app?redirect_uri=https%3A%2F%2Fstripe-cc-production.up.railway.app%2Foauth%2Fcallback&state=CC_VID";

/* Shared closing CTA band — identical across how-it-works, trust, and FAQ
 * pages so those pages share one recipe. Retokenized to the new palette;
 * copy unchanged. */
export function SiteCTA() {
  return (
    <section className={`bg-band ${PY_CTA}`}>
      <div className="max-w-3xl mx-auto px-6 text-center">
        <h2 className="font-display text-[28px] sm:text-[30px] font-semibold tracking-[-0.01em] text-ink mb-4">
          Ready to stop chasing payments?
        </h2>
        <p className="text-muted max-w-lg mx-auto mb-4">
          Install from the Stripe App Marketplace. Polite, personalized, and
          persistent reminders — without you lifting a finger.
        </p>
        <p className="text-brand-deep max-w-lg mx-auto mb-8">
          Your first month is free — full access, no card required. After that,
          Draft Mode stays free forever with unlimited drafts. Subscribe inside
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

const INSTALL_URL =
  "https://marketplace.stripe.com/apps/install/link/com.stripecollectionscopilot.app?redirect_uri=https%3A%2F%2Fstripe-cc-production.up.railway.app%2Foauth%2Fcallback&state=CC_VID";

export function SiteFooter({ businessName = "" }: { businessName?: string }) {
  const wordmark = businessName || "Collections Copilot";
  return (
    <footer className="bg-footer text-white">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 items-center gap-y-6 md:grid-cols-[1fr_auto_1fr]">
          <a href="/" className="flex items-center gap-3 justify-self-start">
            <img
              src="/collectionscopilot-logo.png"
              alt="Collections Copilot logo"
              className="h-8 w-auto"
            />
            <span className="font-display text-lg font-semibold tracking-tight text-white">
              {wordmark}
            </span>
          </a>
          <p className="font-display text-sm font-medium tracking-wide text-white/70 justify-self-start md:justify-self-center">
            Less chasing. More cash.
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-footer-muted justify-self-start md:justify-self-end">
            <a href="/how-it-works" className="transition-colors hover:text-white">
              How it works
            </a>
            <a href="/#pricing" className="transition-colors hover:text-white">
              Pricing
            </a>
            <a href="/faq" className="transition-colors hover:text-white">
              FAQ
            </a>
            <a
              href={INSTALL_URL}
              className="inline-flex items-center justify-center rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-deep"
            >
              Get started
            </a>
          </div>
        </div>
        <div className="mt-10 flex flex-col items-center gap-4 border-t border-white/10 pt-6 text-[13px] text-footer-muted">
          <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2">
            <a href="/privacy" className="transition-colors hover:text-white">
              Privacy Policy
            </a>
            <a href="/terms" className="transition-colors hover:text-white">
              Terms
            </a>
            <a href="/support" className="transition-colors hover:text-white">
              Support
            </a>
            <a href="/about" className="transition-colors hover:text-white">
              About
            </a>
          </div>
          <a
            href="https://peerpush.com/p/collectionscopilot"
            target="_blank"
            rel="noopener"
            className="inline-block"
          >
            <img
              src="https://peerpush.com/p/collectionscopilot/badge.png"
              alt="Collections Copilot on PeerPush"
              style={{ width: 230 }}
            />
          </a>
        </div>
      </div>
    </footer>
  );
}

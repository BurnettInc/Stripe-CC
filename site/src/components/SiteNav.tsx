import { BTN_PRIMARY_NAV, BTN_SECONDARY_NAV } from "./ui";

const INSTALL_URL =
  "https://marketplace.stripe.com/apps/install/link/com.stripecollectionscopilot.app?redirect_uri=https%3A%2F%2Fstripe-cc-production.up.railway.app%2Foauth%2Fcallback&state=CC_VID";

const LINKS = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/faq", label: "FAQ" },
];

function renderName(name: string) {
  const idx = name.lastIndexOf("Copilot");
  if (idx > 0) {
    return (
      <>
        {name.slice(0, idx)}
        <span className="font-bold text-brand">{name.slice(idx)}</span>
      </>
    );
  }
  return name;
}

export function SiteNav({ businessName = "" }: { businessName?: string }) {
  return (
    <nav className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-6 py-4 max-w-6xl mx-auto">
      <a href="/" className="flex items-center gap-3">
        <img src="/collectionscopilot-logo.png" alt="Collections Copilot logo" className="h-10 w-auto" />
        <span className="font-display text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          {renderName(businessName || "Collections Copilot")}
        </span>
      </a>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-muted">
        {LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className="transition-colors hover:text-brand-deep"
          >
            {l.label}
          </a>
        ))}
        <a href="/demo" className={BTN_SECONDARY_NAV}>
          See the demo
        </a>
        <a href={INSTALL_URL} className={BTN_PRIMARY_NAV}>
          Get started
        </a>
      </div>
    </nav>
  );
}

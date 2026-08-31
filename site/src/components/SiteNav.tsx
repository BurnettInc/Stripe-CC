const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";

const LINKS = [
  { href: "/how-it-works", label: "How it Works" },
  { href: "/trust", label: "Trust & Security" },
  { href: "/faq", label: "FAQ" },
];

function renderName(name: string) {
  const idx = name.lastIndexOf("Copilot");
  if (idx > 0) {
    return (
      <>
        {name.slice(0, idx)}
        <span className="font-bold text-indigo-700">{name.slice(idx)}</span>
      </>
    );
  }
  return name;
}

export function SiteNav({ businessName = "" }: { businessName?: string }) {
  return (
    <nav className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-6 py-4 max-w-6xl mx-auto">
      <a href="/" className="flex items-center gap-3">
        <span className="inline-flex items-center justify-center rounded-lg bg-indigo-50 p-1.5 ring-1 ring-indigo-100">
          <img src="/icon.svg" alt="CollectionsCopilot" className="h-9 w-auto" />
        </span>
        <span className="text-lg sm:text-xl tracking-tight text-gray-900">
          {renderName(businessName || "CollectionsCopilot")}
        </span>
      </a>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm font-medium text-gray-700">
        {LINKS.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className="hover:text-indigo-700 transition-colors"
          >
            {l.label}
          </a>
        ))}
        <a
          href={INSTALL_URL}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700"
        >
          Get started
        </a>
      </div>
    </nav>
  );
}

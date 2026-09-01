export function SiteFooter({ businessName = "" }: { businessName?: string }) {
  return (
    <footer className="border-t border-gray-200 py-8 text-center text-sm text-gray-500">
      <img
        src="/logo.png"
        alt="Collections Copilot logo"
        className="h-8 w-auto mx-auto mb-4"
      />
      <div className="flex flex-wrap justify-center items-center gap-x-6 gap-y-2 mb-3">
        <a href="/how-it-works" className="hover:text-gray-700 transition-colors">
          How it Works
        </a>
        <a href="/trust" className="hover:text-gray-700 transition-colors">
          Trust &amp; Security
        </a>
        <a href="/faq" className="hover:text-gray-700 transition-colors">
          FAQ
        </a>
        <a href="/privacy" className="hover:text-gray-700 transition-colors">
          Privacy Policy
        </a>
        <a href="/terms" className="hover:text-gray-700 transition-colors">
          Terms of Service
        </a>
        <a href="/about" className="hover:text-gray-700 transition-colors">
          About
        </a>
        <a href="/support" className="hover:text-gray-700 transition-colors">
          Support
        </a>
      </div>
      <p>{businessName || "Collections Copilot"}</p>
    </footer>
  );
}

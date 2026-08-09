import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: Privacy,
});

function Privacy() {
  return (
    <div className="min-h-dvh bg-white">
      <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-3">
            <img src="/icon.svg" alt="CollectionsCopilot" className="h-8 w-auto" />
            <span className="font-bold text-lg text-indigo-600">CollectionsCopilot</span>
          </a>
        </div>
        <a
          href="/"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          ← Back
        </a>
      </nav>
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-gray">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: August 2026</p>

        <p className="text-gray-700 leading-relaxed">
          CollectionsCopilot is operated by Cody Burnett, a sole proprietor
          based in Texas, USA. This policy explains what data the app collects, how
          it's used, and who it's shared with.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">1. What we collect</h2>
        <p className="text-gray-700 leading-relaxed">
          When you connect your Stripe account via Stripe Connect OAuth, we access:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Invoice data — amounts, due dates, status, customer names, and customer email addresses</li>
          <li>Payment status information for tracked invoices</li>
          <li>Your Stripe account's display name and email address</li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          We also store an OAuth access token so the app can monitor your invoices
          on your behalf. This token is encrypted at rest (see Security below). We do
          not store your Stripe login credentials or your Stripe API keys.
        </p>

        <p className="text-gray-700 leading-relaxed mt-4">
          The app sets a single session cookie (<code>session</code>) when you sign in
          via Stripe. It is HttpOnly, Secure, and SameSite=Lax, and expires after 30
          days. We set no other cookies and we do not use analytics scripts, tracking
          pixels, localStorage, or sessionStorage anywhere in the app or on our
          marketing site.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">2. How we use your data</h2>
        <p className="text-gray-700 leading-relaxed">
          We use your invoice data only to provide the service:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Detect overdue invoices</li>
          <li>Draft and send personalized reminder emails to your customers</li>
          <li>Stop reminder sequences when an invoice is paid</li>
          <li>Generate weekly recovery summaries for you</li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          We do not sell your data or your customers' data. We do not use it for
          advertising, profiling, or any purpose other than the reminder service you
          signed up for.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">3. Third-party services</h2>
        <p className="text-gray-700 leading-relaxed">
          The app uses the following services, each only when configured:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>
            <strong>Stripe</strong> — for OAuth authentication, invoice data access,
            and subscription billing. Stripe processes data according to its own
            privacy policy.
          </li>
          <li>
            <strong>An AI provider</strong> (e.g. OpenAI) — drafts reminder emails.
            The AI receives the customer's name, invoice amount and number, due date,
            days overdue, escalation stage, and a summary of payment history. The
            customer's <em>email address is never sent to the AI</em>.
          </li>
          <li>
            <strong>SendGrid or Resend</strong> — delivers the reminder emails. The
            email provider receives the customer's email address, the email subject,
            body, and sender address. Either provider is used only when its API key
            is configured; if neither is set, emails are not sent.
          </li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          No other third parties receive your data.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">4. Data retention</h2>
        <p className="text-gray-700 leading-relaxed">
          Invoice and reminder data is kept for as long as your account is active. If
          you cancel your subscription, your data is deleted within 30 days. You can
          request immediate deletion at any time by contacting us.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">5. Security</h2>
        <p className="text-gray-700 leading-relaxed">
          Stripe OAuth access and refresh tokens are encrypted at rest using
          AES-256-GCM. The database file is locked to owner-only permissions (chmod
          600). All communication between the app and Stripe uses HTTPS.
        </p>
        <p className="text-gray-700 leading-relaxed mt-2">
          That said, no online service is completely immune to security risk. If you
          discover a vulnerability, please notify us immediately.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">6. Your rights</h2>
        <p className="text-gray-700 leading-relaxed">
          You can:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Disconnect your Stripe account at any time</li>
          <li>Pause or cancel active reminder sequences</li>
          <li>Request a copy of your stored data</li>
          <li>Request correction or deletion of your data</li>
        </ul>
        <p className="text-gray-700 leading-relaxed mt-2">
          To exercise any of these rights, contact us at the email below. We'll
          respond within 30 days.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">7. Contact</h2>
        <p className="text-gray-700 leading-relaxed">
          Cody Burnett, sole proprietor — Texas, USA.{" "}
          <a href="mailto:support@getcollectionscopilot.com" className="text-indigo-600 underline">
            support@getcollectionscopilot.com
          </a>
        </p>
      </main>
    </div>
  );
}

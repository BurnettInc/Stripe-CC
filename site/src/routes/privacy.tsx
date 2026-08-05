import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  component: Privacy,
});

function Privacy() {
  return (
    <div className="min-h-dvh bg-white">
      <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <a href="/" className="font-bold text-lg text-indigo-600">
          Stripe Collections Copilot
        </a>
        <a
          href="/"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          ← Back
        </a>
      </nav>
      <main className="max-w-3xl mx-auto px-6 py-12 prose prose-gray">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: July 2026</p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">1. What we collect</h2>
        <p className="text-gray-700 leading-relaxed">
          When you connect your Stripe account to Stripe Collections Copilot, we access:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Invoice data (amounts, due dates, customer names, customer email addresses)</li>
          <li>Payment status information</li>
          <li>Your Stripe account email address</li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          We do NOT store your Stripe API keys. Authentication is handled via Stripe Connect OAuth.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">2. How we use your data</h2>
        <p className="text-gray-700 leading-relaxed">
          We use invoice data solely to:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Detect overdue invoices</li>
          <li>Generate and send personalized email reminders to your customers</li>
          <li>Track payment status to stop reminder sequences when invoices are paid</li>
          <li>Generate weekly summary reports for you</li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          We do NOT sell, share, or use your invoice data or customer data for any other purpose.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">3. Email sending</h2>
        <p className="text-gray-700 leading-relaxed">
          When reminders are sent, they are dispatched via your connected email provider (Gmail/SendGrid).
          We send emails only to the customer email addresses associated with overdue invoices in your
          Stripe account. We do not email your customers for any other reason.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">4. Data retention</h2>
        <p className="text-gray-700 leading-relaxed">
          Invoice and reminder data is retained for as long as your account is active. If you cancel
          your subscription, your data is deleted within 30 days. You may request immediate deletion
          by contacting support.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">5. Third-party services</h2>
        <p className="text-gray-700 leading-relaxed">
          Stripe Collections Copilot integrates with:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Stripe (payment processing, invoicing data)</li>
          <li>Your chosen email provider (Gmail or SendGrid)</li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          Each of these services has its own privacy policy governing how they handle data.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">6. Security</h2>
        <p className="text-gray-700 leading-relaxed">
          All data transmission uses HTTPS. We do not store payment method details or Stripe API keys.
          Access to your data is limited to the automated reminder pipeline.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">7. Your rights</h2>
        <p className="text-gray-700 leading-relaxed">
          You may:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Disconnect your Stripe account at any time</li>
          <li>Pause or cancel active reminder sequences</li>
          <li>Request deletion of your data</li>
          <li>Export your reminder history</li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">8. Contact</h2>
        <p className="text-gray-700 leading-relaxed">
          For privacy questions or data requests, contact us at{" "}
          <a href="mailto:stripecopilot@outlook.com" className="text-indigo-600 underline">
            stripecopilot@outlook.com
          </a>.
        </p>
      </main>
    </div>
  );
}

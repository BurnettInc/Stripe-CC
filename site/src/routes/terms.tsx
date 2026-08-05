import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  component: Terms,
});

function Terms() {
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
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: July 2026</p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">1. Acceptance of terms</h2>
        <p className="text-gray-700 leading-relaxed">
          By accessing or using Stripe Collections Copilot ("the Service"), you agree to be bound by
          these Terms of Service. If you do not agree, do not use the Service.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">2. Description of service</h2>
        <p className="text-gray-700 leading-relaxed">
          Stripe Collections Copilot is an automated invoice follow-up service that connects to your
          Stripe account to detect overdue invoices and send personalized email reminders to your
          customers. The Service operates according to the Trust Mode you select (Draft, Semi-Auto, or
          Full Auto).
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">3. Subscription and billing</h2>
        <p className="text-gray-700 leading-relaxed">
          The Service is offered on a monthly subscription basis. Plans and pricing are displayed on
          our website. Subscriptions are billed in advance and automatically renew until cancelled.
          You may cancel at any time — cancellation takes effect at the end of the current billing
          period. All payments are processed through Stripe.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">4. User responsibilities</h2>
        <p className="text-gray-700 leading-relaxed">
          You are responsible for:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>Ensuring you have the right to contact customers whose invoice data you process through the Service</li>
          <li>Configuring the Trust Mode appropriately for your business needs</li>
          <li>Reviewing drafted emails in Draft Mode before they are sent</li>
          <li>Maintaining accurate invoice and customer data in your Stripe account</li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">5. Service limitations</h2>
        <p className="text-gray-700 leading-relaxed">
          The Service is provided "as is" without warranties of any kind. We do not guarantee that
          reminders will result in payment or that the Service will be error-free. We are not
          responsible for late or failed payments, or for any consequences of emails sent through
          the Service.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">6. Data and privacy</h2>
        <p className="text-gray-700 leading-relaxed">
          Use of the Service is also governed by our{" "}
          <a href="/privacy" className="text-indigo-600 underline">Privacy Policy</a>,
          which explains how we collect, use, and protect your data.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">7. Termination</h2>
        <p className="text-gray-700 leading-relaxed">
          We reserve the right to suspend or terminate your access to the Service for violations of
          these terms. You may terminate your account at any time by cancelling your subscription.
          Upon termination, your data is handled as described in our Privacy Policy.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">8. Changes to terms</h2>
        <p className="text-gray-700 leading-relaxed">
          We may update these terms from time to time. Continued use of the Service after changes
          constitutes acceptance of the new terms.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">9. Contact</h2>
        <p className="text-gray-700 leading-relaxed">
          For questions about these terms, contact us at{" "}
          <a href="mailto:stripecopilot@outlook.com" className="text-indigo-600 underline">
            stripecopilot@outlook.com
          </a>.
        </p>
      </main>
    </div>
  );
}

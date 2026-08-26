import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  component: Terms,
});

function Terms() {
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
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-8">Last updated: August 2026</p>

        <p className="text-gray-700 leading-relaxed">
          These terms govern your use of CollectionsCopilot ("the Service"),
          operated by Cody Burnett, a sole proprietor based in Texas, USA. By using
          the Service, you agree to these terms.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">1. What the Service does</h2>
        <p className="text-gray-700 leading-relaxed">
          CollectionsCopilot connects to your Stripe account, detects overdue
          invoices, and sends automated, escalating reminder emails to your customers
          on your behalf. The Service operates according to the Trust Mode you select:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li><strong>Draft</strong> — emails are written but not sent until you approve them</li>
          <li><strong>Semi-Auto</strong> — early, friendly reminders send automatically; later stages wait for your approval</li>
          <li><strong>Full Auto</strong> — the entire sequence runs without manual intervention</li>
        </ul>
        <p className="text-gray-700 leading-relaxed">
          You can switch Trust Modes at any time, including per-invoice overrides.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">2. Free tier and subscriptions</h2>
        <p className="text-gray-700 leading-relaxed">
          The Service offers a free tier that lets you view AI-drafted reminders for up
          to five real overdue invoices. On the free tier, emails are sent only when
          you approve them, or automatically for Stage-1 reminders if you select
          Semi-Auto (Full Auto is a Pro feature). To unlock more sending, you must
          subscribe to a paid plan (Standard at $7/month or Pro at $15/month).
          Subscriptions are billed monthly in advance via Stripe and renew
          automatically until cancelled. You can cancel at any time — cancellation
          takes effect at the end of the current billing period and you retain access
          until then. All payments are processed through Stripe; we do not store your
          payment method details.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">3. Your responsibilities</h2>
        <p className="text-gray-700 leading-relaxed">
          You agree that:
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>You have the right to contact the customers whose invoice data you process through the Service</li>
          <li>You will configure the Trust Mode appropriately for your business</li>
          <li>In Draft Mode, you will review emails before approving them for sending</li>
          <li>You will keep your invoice and customer data accurate in your Stripe account</li>
          <li>You will not use the Service for unlawful, harassing, or deceptive communications</li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">4. Service limitations</h2>
        <p className="text-gray-700 leading-relaxed">
          The Service is provided "as is." We do not guarantee that reminders will
          result in payment, that the Service will be uninterrupted or error-free, or
          that every overdue invoice will be detected. We are not liable for late or
          missed payments, or for any consequences of emails sent through the Service.
          Use the Service at your own discretion — particularly in Full Auto mode,
          where emails are sent without your review.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">5. Privacy</h2>
        <p className="text-gray-700 leading-relaxed">
          How we handle your data is covered in our{" "}
          <a href="/privacy" className="text-indigo-600 underline">Privacy Policy</a>.
          By using the Service, you also agree to the data practices described there.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">6. Termination</h2>
        <p className="text-gray-700 leading-relaxed">
          We may suspend or terminate your access if you violate these terms or use the
          Service in a way that harms other users or the Service itself. You may
          terminate your account at any time by cancelling your subscription and
          disconnecting your Stripe account. After termination, your data is deleted
          within 30 days as described in the Privacy Policy.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">7. Changes to these terms</h2>
        <p className="text-gray-700 leading-relaxed">
          We may update these terms occasionally. If we make material changes, we'll
          notify you through the Service or by email. Continued use after changes are
          posted means you accept the updated terms.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">8. Governing law</h2>
        <p className="text-gray-700 leading-relaxed">
          These terms are governed by the laws of the State of Texas, USA. Any disputes
          will be resolved in the courts of Texas.
        </p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">9. Contact</h2>
        <p className="text-gray-700 leading-relaxed">
          Cody Burnett —{" "}
          <a href="mailto:support@getcollectionscopilot.com" className="text-indigo-600 underline">
            support@getcollectionscopilot.com
          </a>
        </p>
      </main>
    </div>
  );
}

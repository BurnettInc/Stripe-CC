import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/support")({
  component: Support,
});

function Support() {
  return (
    <div className="min-h-dvh bg-white">
      <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-3">
            <img src="/logo.png" alt="Collections Copilot logo" className="h-8 w-auto" />
            <span className="font-bold text-lg text-indigo-600">Collections Copilot</span>
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
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Support</h1>
        <p className="text-sm text-gray-500 mb-8">One channel: support@getcollectionscopilot.com</p>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">How support works</h2>
        <p className="text-gray-700 leading-relaxed">
          Email us at{" "}
          <a href="mailto:support@getcollectionscopilot.com" className="text-indigo-600 underline">
            support@getcollectionscopilot.com
          </a>{" "}
          and a real person from the team will get back to you.
        </p>
        <ul className="list-disc pl-6 text-gray-700 space-y-1">
          <li>
            <strong>Pro</strong> — same-business-day first response, typically within 24 hours on
            weekdays. We pull up your account before we reply, so you never re-explain your setup.
          </li>
          <li>
            <strong>Standard</strong> — first response within 2 business days.
          </li>
        </ul>

        <h2 className="text-xl font-semibold text-gray-900 mt-8">What support covers</h2>
        <p className="text-gray-700 leading-relaxed">
          Support means a real answer from the team, not an autoresponder. It covers setup help,
          billing questions, disputes, and pausing or stopping sequences.
        </p>
        <p className="text-gray-700 leading-relaxed">
          Support does <strong>not</strong> include 24/7 coverage, phone support, guaranteed
          resolution times, or a dedicated account manager. First response times above are when you
          first hear back from us — not a promise that every issue is resolved within that window.
        </p>
      </main>
    </div>
  );
}

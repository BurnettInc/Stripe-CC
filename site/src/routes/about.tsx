import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <div className="min-h-dvh bg-white">
      <nav className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-3">
            <img src="/collectionscopilot-logo.png" alt="Collections Copilot logo" className="h-8 w-auto" />
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
        <h1 className="text-3xl font-bold text-gray-900 mb-2">About Collections Copilot</h1>

        <p className="text-gray-700 leading-relaxed">
          Collections Copilot was built by Cody Burnett, a solo developer frustrated
          with chasing down late invoice payments manually. Rather than another
          all-or-nothing automation tool, it's designed around one idea: you should
          be able to start cautious and earn your way to hands-off, on your own
          timeline.
        </p>

        <p className="text-gray-700 leading-relaxed mt-4">
          Questions or feedback? Reach out at{" "}
          <a href="mailto:support@getcollectionscopilot.com" className="text-indigo-600 underline">
            support@getcollectionscopilot.com
          </a>{" "}
          — I read every message.
        </p>
      </main>
    </div>
  );
}

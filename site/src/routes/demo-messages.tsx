import { createFileRoute } from "@tanstack/react-router";
import { buildDemoDoc, HANDOFF_ANCHOR, DemoPageShell } from "../components/demoShim";

/* The LIVE messages page (served at /messages by the backend) is the single
 * source of truth — bundled in verbatim so the demo renders pixel-identical. */
import messagesHtml from "../../../app/src/ui/messages.html?raw";

/* Public /demo-messages — exact replica of the real Messages page (app/
 * src/ui/messages.html): task/inbox approval queue + Sent-reminder history.
 * The shared demo shim answers every endpoint it calls (/tasks, /settings,
 * /stats, /subscription, /reminders/rows — the Sent tab's fragment), maps
 * shell links to /demo* views, and blocks real-account actions. */
const DEMO_MESSAGES_DOC = buildDemoDoc(messagesHtml, HANDOFF_ANCHOR);

export const Route = createFileRoute("/demo-messages")({
  component: DemoMessages,
});

function DemoMessages() {
  return (
    <DemoPageShell
      banner="⚠ Demo Mode — sample data only, nothing sends, nothing is saved"
      heading="See the message center in action"
      body="Every customer, invoice, and email below is made-up sample data — nothing here is real, nothing sends, and nothing is saved. This is the same Message center a merchant sees: the approval queue for AI-drafted reminders, and the full sent-reminder history (open any row to read the email exactly as it was sent). Every tab and drill-down below is a working demo — only actions that need a real Stripe account are disabled."
      activeTab="messages"
      frameTitle="Collections Copilot messages demo (exact replica)"
      srcDoc={DEMO_MESSAGES_DOC}
      minHeight={700}
    />
  );
}
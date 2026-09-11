import { createFileRoute } from "@tanstack/react-router";
import { buildDemoDoc, HANDOFF_ANCHOR, DemoPageShell } from "../components/demoShim";

/* The LIVE Copilot Controls page (served at /copilot-controls by the
 * backend) is the single source of truth — bundled in verbatim so the demo
 * renders pixel-identical. */
import copilotControlsHtml from "../../../app/src/ui/copilot-controls.html?raw";

/* Public /demo-copilot-controls — exact replica of the real Copilot
 * Controls page (app/src/ui/copilot-controls.html): Trust Mode selector,
 * escalation schedule and send settings. The shared demo shim answers its
 * endpoints (/settings, /stats, /subscription; PUT /settings applies the
 * picked mode to the in-memory seed), maps shell links to /demo* views, and
 * blocks real-account actions. */
const DEMO_CONTROLS_DOC = buildDemoDoc(copilotControlsHtml, HANDOFF_ANCHOR);

export const Route = createFileRoute("/demo-copilot-controls")({
  component: DemoCopilotControls,
});

function DemoCopilotControls() {
  return (
    <DemoPageShell
      banner="⚠ Demo Mode — sample data only, nothing sends, nothing is saved"
      heading="See Copilot Controls in action"
      body="Every setting below is made-up sample data — nothing here is real, nothing sends, and nothing is saved. This is the same Copilot Controls page a merchant sees to set how much autonomy Collections Copilot gets: Draft Mode, Semi-Auto and full Copilot Mode, plus the escalation schedule and sender settings. Change a setting and hit Save — it applies to the sample only. Every tab and drill-down below is a working demo — only actions that need a real Stripe account are disabled."
      activeTab="controls"
      frameTitle="Collections Copilot Copilot Controls demo (exact replica)"
      srcDoc={DEMO_CONTROLS_DOC}
      minHeight={700}
    />
  );
}
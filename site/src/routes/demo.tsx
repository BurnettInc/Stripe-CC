import { createFileRoute } from "@tanstack/react-router";
import { buildDemoDoc, HANDOFF_ANCHOR, DemoPageShell } from "../components/demoShim";

/* The LIVE dashboard file (served at /dashboard) is the single source of
 * truth — bundled in verbatim so the demo renders pixel-identical. */
import dashboardHtml from "../../../app/src/ui/dashboard.html?raw";

/* ------------------------------------------------------------------ *
 *  Public /demo — exact replica of the real dashboard, run in DEMO_MODE.
 *
 *  Single source of truth: the LIVE dashboard file served at /dashboard
 *  (app/src/ui/dashboard.html) is bundled in at build time via vite ?raw
 *  (same markup, CSS and JS — pixel-identical). The shared demo shim
 *  (components/demoShim.tsx) then: strips the visit beacon, injects the
 *  DEMO_MODE fetch table (fictional seeds, no network), maps every internal
 *  app link (/dashboard /past-due /reminders /messages /copilot-controls
 *  /account) to its /demo* route (explorable sandbox, no popups), blocks
 *  real-account actions (/stripe/connect /oauth/ /billing/* /account/export)
 *  with the honest notice, and keeps the parent <iframe> sized. This file
 *  only adds the dashboard-specific demo boot: the pipeline stage strip,
 *  live Trust-Mode line, and honest stat labels.
 *
 *  Zero persistence: all demo state lives in the iframe's memory and
 *  refreshes reset to the seed. The conversion CTA links to the REAL
 *  install URL with utm_source=demo.
 *
 *  All customer/invoice/email data below the header is fictional.
 * ------------------------------------------------------------------ */

const RAW_DASHBOARD = dashboardHtml;

/* ── Dashboard-specific demo boot ─────────────────────────────────────
 * Runs from the shared shim's __demoBoot hook (window.__demoExtraBoot),
 * after the dashboard's own script has initialized. Everything here is
 * dashboard-only: the injected pipeline strip, live counts, mode line,
 * renderInbox/saveSettings/loadStats wraps, honest stat labels, and the
 * recovery-report demo copy patch. The fetch route table, click
 * neutralizer, handoff patch and iframe height push all live in
 * components/demoShim.tsx. */
const DASHBOARD_DEMO_BOOT = `
// Dashboard-specific demo boot (site/src/routes/demo.tsx, via the shared
// shim's __demoExtraBoot hook): pipeline strip, live counts, honest labels.
(function () {
  window.__demoExtraBoot = function __dashExtraBoot() {
    // Pipeline stage strip — Watch / Draft / Review / Send with live counts.
    var inboxCard = document.getElementById('inbox-section');
    if (inboxCard && !document.getElementById('demo-pipeline-strip')) {
      var strip = document.createElement('div');
      strip.className = 'card';
      strip.id = 'demo-pipeline-strip';
      strip.innerHTML =
        '<h2>📋 Pipeline</h2>' +
        '<p class="subtitle">Where each overdue invoice sits right now — sample data only. Approve a draft below and it moves to Send.</p>' +
        '<div id="demo-pipe-chips" style="display:flex;gap:12px;flex-wrap:wrap;"></div>' +
        '<div id="demo-mode-line" style="margin-top:16px;padding:12px 14px;border-radius:var(--radius-sm);background:var(--primary-light);color:var(--primary-hover);font-size:0.85rem;font-weight:600;"></div>';
      inboxCard.parentNode.insertBefore(strip, inboxCard);
    }

    var CHIP_DEFS = [
      { key: 'watch', label: 'Watch', desc: 'newly overdue · not drafted yet', accent: '#6B7280' },
      { key: 'draft', label: 'Draft', desc: 'AI-drafted · waiting on you', accent: '#4F46E5' },
      { key: 'review', label: 'Review', desc: 'ready to send · awaiting sign-off', accent: '#B45309' },
      { key: 'send', label: 'Send', desc: 'reminders already sent (demo)', accent: '#047857' }
    ];
    var chipsEl = document.getElementById('demo-pipe-chips');
    var myChips = {};
    if (chipsEl) {
      chipsEl.innerHTML = CHIP_DEFS.map(function (c) {
        return '<div style="flex:1;min-width:130px;border:1px solid var(--border);border-radius:var(--radius);background:#fff;padding:14px 16px;text-align:center;box-shadow:var(--shadow);">' +
          '<div style="font-size:0.7rem;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:' + c.accent + ';">' + c.label + '</div>' +
          '<div id="demo-count-' + c.key + '" style="font-size:1.5rem;font-weight:700;color:' + c.accent + ';line-height:1.3;">0</div>' +
          '<div style="font-size:0.72rem;color:var(--muted);margin-top:2px;">' + c.desc + '</div>' +
          '</div>';
      }).join('');
      CHIP_DEFS.forEach(function (c) { myChips[c.key] = document.getElementById('demo-count-' + c.key); });
    }

    function __demoCounts() {
      var watch = 0, draft = 0, review = 0;
      window.__demoState.tasks.forEach(function (t) {
        var hasDraft = t.draft_body && String(t.draft_body).trim() !== '';
        if (t.status === 'reviewed') review += 1;
        else if (hasDraft && t.status === 'drafted') draft += 1;
        else if (hasDraft) draft += 1;
        else watch += 1;
      });
      return { watch: watch, draft: draft, review: review, send: window.__demoState.sentEmails.length };
    }
    function __demoRenderChips() {
      if (!chipsEl || !myChips.watch) return;
      var c = __demoCounts();
      myChips.watch.textContent = String(c.watch);
      myChips.draft.textContent = String(c.draft);
      myChips.review.textContent = String(c.review);
      myChips.send.textContent = String(c.send);
    }
    function __demoModeLine() {
      var el = document.getElementById('demo-mode-line');
      if (!el) return;
      var checked = document.querySelector('input[name="trust_mode"]:checked');
      var m = (checked && checked.value) || window.currentTrustMode || 'draft';
      var lines = {
        draft: 'Draft Mode: every reminder is drafted and waits for your approval — nothing sends without you.',
        semi: 'Semi-Auto: Stage 1 friendly nudges send themselves; Stages 2 and 3 still wait for your approval.',
        full: 'Copilot Mode: the whole sequence drafts, reviews, and sends on its own. You are notified, never asked.'
      };
      el.textContent = lines[m] || lines.draft;
    }

    // Wrap renderInbox so the strip counts stay live after approve/reject/save.
    try {
      var _ri = window.renderInbox;
      window.renderInbox = function () { var r = _ri.apply(this, arguments); __demoRenderChips(); return r; };
    } catch (e) {}
    // Pill clicks update the mode line live (before Save).
    try {
      document.querySelectorAll('.trust-pill').forEach(function (pill) {
        pill.addEventListener('click', function () { window.setTimeout(function () { __demoModeLine(); __demoRenderChips(); }, 0); });
      });
    } catch (e) {}
    // Save Settings / pause / summary reflect the picked mode immediately and
    // stay honest (demo — nothing is persisted anywhere).
    try {
      var _ss = window.saveSettings;
      window.saveSettings = function () {
        var r = _ss.apply(this, arguments);
        window.setTimeout(function () { __demoModeLine(); }, 0);
        return r;
      };
      var _sms = window.saveMerchantSettings;
      window.saveMerchantSettings = function () {
        var r = _sms.apply(this, arguments);
        if (r && r.then) { r.then(function () { __demoPatchLabels(); }, function () {}); }
        return r;
      };
    } catch (e) {}
    // Keep the stats honest for the demo ("X demo sends (fictional)" — the
    // dashboard's own label says "real sends", which would be untrue here).
    function __demoPatchLabels() {
      var el = document.getElementById('stat-emails');
      if (el) el.textContent = window.__demoState.sentEmails.length + ' demo sends (fictional)';
      var paid = document.getElementById('stat-paid');
      if (paid) paid.textContent = '0 paid · ' + window.__demoState.stats.overdueInvoices + ' overdue (sample data)';
      var inv = document.getElementById('stat-invoices');
      if (inv) inv.textContent = String(9);
      // NOTE: stat-card LINKS are intentionally left intact — the shared
      // click neutralizer maps them to the matching /demo* view, so drill-
      // downs work inside the sandbox. The free-drafts card points at
      // /billing/checkout, which is a real-account action and keeps the
      // honest notice (matching the real app's upgrade path).
    }
    try {
      var _ls = window.loadStats;
      window.loadStats = function () {
        var r = _ls.apply(this, arguments);
        if (r && r.then) { r.then(function () { __demoPatchLabels(); }, function () {}); } else { __demoPatchLabels(); }
        return r;
      };
    } catch (e) {}
    __demoPatchLabels();
    __demoRenderChips();
    __demoModeLine();

    // Weekly recovery report card: the shared shim answers /summary/send
    // with {skipped:true}, so the real handler says "not sent". Replace that
    // with demo-specific copy so no visitor thinks a real email went out.
    try {
      var _ssn = window.sendSummaryNow;
      window.sendSummaryNow = function () {
        var btn0 = document.getElementById('summary-btn');
        var origHtml = btn0 ? btn0.innerHTML : '';
        var r = _ssn ? _ssn.apply(this, arguments) : undefined;
        var tries = 0;
        var t = window.setInterval(function () {
          tries += 1;
          var statusEl = document.getElementById('summary-status');
          if (statusEl && statusEl.textContent && statusEl.textContent.indexOf('Weekly summary') === 0 && tries > 2) {
            statusEl.textContent = 'Note: this is sample data — no summary email is sent from the demo. In the real app, this emails your weekly recovery report on demand.';
            statusEl.style.color = 'var(--warning)';
            if (btn0) { btn0.disabled = false; btn0.innerHTML = origHtml; }
            window.clearInterval(t);
          }
          if (tries > 50) window.clearInterval(t);
        }, 60);
        return r;
      };
    } catch (e) {}
  };
})();
`;

const DASHBOARD_DOC = (() => {
  const doc = buildDemoDoc(RAW_DASHBOARD, HANDOFF_ANCHOR);
  // Inject the dashboard-specific extra boot right after the shared shim.
  return doc.replace(
    HANDOFF_ANCHOR,
    `${DASHBOARD_DEMO_BOOT}\n    ${HANDOFF_ANCHOR}`,
  );
})();

export const Route = createFileRoute("/demo")({
  component: Demo,
});

function Demo() {
  return (
    <DemoPageShell
      banner="⚠ Demo Mode — sample data only, nothing sends, nothing is saved"
      heading="See the collections pipeline in action"
      body="This is what an overdue-invoice queue looks like inside Collections Copilot. Every customer, invoice, and email below is made-up sample data — nothing here is real, nothing sends, and nothing is saved. Click an invoice to open it, then try the Trust Mode toggle to see how each mode behaves. Every tab and drill-down below is a working demo — only actions that need a real Stripe account (billing, Stripe connect, export) are disabled."
      activeTab="dashboard"
      frameTitle="Collections Copilot dashboard demo (exact replica)"
      srcDoc={DASHBOARD_DOC}
      minHeight={650}
    />
  );
}
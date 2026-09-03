import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { SiteNav } from "../components/SiteNav";
import { SiteFooter } from "../components/SiteFooter";
import { DemoTabs } from "../components/DemoListPage";
import { BTN_PRIMARY, BTN_SECONDARY } from "../components/ui";

/* The LIVE dashboard file (served at /dashboard) is the single source of
 * truth — bundled in verbatim so the demo renders pixel-identical. */
import dashboardHtml from "../../../app/src/ui/dashboard.html?raw";

/* ------------------------------------------------------------------ *
 *  Public /demo — exact replica of the real dashboard, run in DEMO_MODE.
 *
 *  Single source of truth: the LIVE dashboard file served at /dashboard
 *  (app/src/ui/dashboard.html) is bundled in at build time via vite ?raw
 *  (same markup, CSS and JS — pixel-identical). The demo route then:
 *    1. strips the dashboard's own visit-tracking beacon (its POST to
 *       /api/track must NOT fire from inside the demo),
 *    2. injects a DEMO_MODE shim at the top of the dashboard's inline
 *       script — every fetch('/stats'|'/settings'|'/tasks'|'/subscription'
 *       |'/health'|...) is answered from fictional in-memory seed data,
 *       so there is no network call, no database, no Stripe, no email,
 *    3. renders the resulting document in a same-origin <iframe srcdoc>
 *       so the dashboard's own page-level CSS (body background etc.) can
 *       never collide with the marketing site, then dynamically resizes
 *       the frame to fit (postMessage).
 *
 *  Zero persistence: all demo state lives in the iframe's memory and
 *  refreshes reset to the seed. The conversion CTA links to the REAL
 *  install URL with utm_source=demo.
 *
 *  All customer/invoice/email data below the header is fictional.
 * ------------------------------------------------------------------ */

const INSTALL_URL = "https://stripe-cc-production.up.railway.app/oauth/install";
const SIGNUP_URL = `${INSTALL_URL}?utm_source=demo`;

const RAW_DASHBOARD = dashboardHtml;

/* ── DEMO_MODE shim ────────────────────────────────────────────────────
 * Inserted at the TOP of the dashboard's main inline <script>, so it runs
 * before the dashboard's own init calls (loadStats/loadSettings/loadInbox/
 * loadSubscription/checkHealth). window.fetch is replaced with a route
 * table over fictional seeds; anything not on the table fails closed. */
const DEMO_MODE_SNIPPET = `
// ─────────────────────────────────────────────────────────────────────
// DEMO_MODE (injected by site/src/routes/demo.tsx) — this copy of the
// dashboard runs against fictional in-memory seed data only. No network,
// no DB, no Stripe, no email. Refreshing the page resets everything.
// ─────────────────────────────────────────────────────────────────────
(function () {
  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  }
  function halt(msg) {
    return Promise.resolve(new Response(JSON.stringify({ error: msg }), { status: 403, headers: { 'Content-Type': 'application/json' } }));
  }
  var D = new Date();
  var iso = function (daysAgo) { var t = new Date(D.getTime() - (daysAgo * 86400000)); return t.toISOString(); };

  // ── Fictional seed data (9 sample invoices across all four stages) ──
  var seedTasks = [
    // Watch — newly overdue, not drafted yet (stages will draft automatically)
    { id: 11, customer_name: 'Avery Chen', company: 'Chen Studio', stage: 1, status: 'pending', amount_cents: 45000, currency: 'usd', due_date: iso(5), days_overdue: 5, created_at: iso(5), draft_subject: '', draft_body: '', invoice_status: 'open' },
    { id: 12, customer_name: 'Leo Fischer', company: 'Fischer Studio', stage: 1, status: 'pending', amount_cents: 72000, currency: 'usd', due_date: iso(3), days_overdue: 3, created_at: iso(3), draft_subject: '', draft_body: '', invoice_status: 'open' },
    // Draft — AI-drafted, waiting on the merchant
    { id: 13, customer_name: 'Marcus Webb', company: 'Webb Digital', stage: 1, status: 'drafted', amount_cents: 125000, currency: 'usd', due_date: iso(6), days_overdue: 6, created_at: iso(6), draft_subject: 'Quick nudge — invoice #1053', draft_body: 'Hi Marcus,\\n\\nHope the site relaunch went well this week. Just a quick nudge that invoice #1053 ($1,250) slipped past its due date — no rush if it has been a busy one.\\n\\nIf it is already on its way, no need to reply. Cheers!', invoice_status: 'open' },
    { id: 14, customer_name: 'Sofia Reyes', company: 'Reyes Collective', stage: 2, status: 'drafted', amount_cents: 64000, currency: 'usd', due_date: iso(9), days_overdue: 9, created_at: iso(9), draft_subject: 'Following up — invoice #1062', draft_body: 'Hi Sofia,\\n\\nFollowing up on invoice #1062 ($640) — it is now a few days past due. If it is already on its way, you can ignore this; if there is a hiccup on your end, happy to work something out.\\n\\nLet me know either way?', invoice_status: 'open' },
    { id: 15, customer_name: 'Priya Natarajan', company: 'Natarajan Design', stage: 2, status: 'drafted', amount_cents: 280000, currency: 'usd', due_date: iso(18), days_overdue: 18, created_at: iso(18), draft_subject: 'Overdue — invoice #1047', draft_body: 'Hi Priya,\\n\\nI wanted to check in personally about invoice #1047 ($2,800), which is now 18 days past its due date. We are past the friendly-reminder stage, so I would really appreciate it if you could arrange payment this week.\\n\\nIf there is a billing question or a specific blocker, reply and I will sort it out right away — otherwise our standard reminders will keep running.', invoice_status: 'open' },
    // Review — final-stage drafts ready for sign-off
    { id: 16, customer_name: 'Elena Petrova', company: 'Petrova Creative', stage: 3, status: 'reviewed', amount_cents: 198000, currency: 'usd', due_date: iso(34), days_overdue: 34, created_at: iso(34), draft_subject: 'Final notice — invoice #1039', draft_body: 'Hi Elena,\\n\\nThis is the final notice for invoice #1039 ($1,980), now 34 days overdue. Two reminders have gone out with no payment received, and per our payment terms this invoice needs to be settled without further delay.\\n\\nPlease arrange payment now — and if there is a dispute or a hardship, contact us today so we can find a solution before any further steps are taken.', invoice_status: 'open' },
    { id: 17, customer_name: 'James Okafor', company: 'Okafor Consulting', stage: 3, status: 'reviewed', amount_cents: 340000, currency: 'usd', due_date: iso(47), days_overdue: 47, created_at: iso(47), draft_subject: 'Final notice before escalation — invoice #1058', draft_body: 'Hi James,\\n\\nInvoice #1058 ($3,400) is now 47 days overdue. Our earlier reminders have gone unanswered, and this is the final notice before we consider next steps under our payment terms, including pausing future work.\\n\\nIf this was an oversight, one quick payment settles it. If there is a reason, reply today — we would much rather sort it out than escalate it.', invoice_status: 'open' }
  ];
  // Emails already "sent" in the sample account (fictional — shown in the
  // pipeline strip's Send column and reflected in the stats).
  var seedSentEmails = [
    { customer: 'Maya Thompson', stage: 2, subject: 'Following up — invoice #1044', daysAgo: 3 },
    { customer: 'Daniel Kim', stage: 1, subject: 'Quick nudge — invoice #1055', daysAgo: 41 },
    { customer: 'Daniel Kim', stage: 2, subject: 'Following up — invoice #1055', daysAgo: 28 },
    { customer: 'Daniel Kim', stage: 3, subject: 'Final notice — invoice #1055', daysAgo: 14 }
  ];

  var demoState = {
    stats: { totalInvoices: 9, paidInvoices: 0, overdueInvoices: 9, remindersSent: seedSentEmails.length, emailsSent: seedSentEmails.length, stripeConnected: true, stripeDisconnected: false, stripeAccountId: 'acct_demo_sample', stripe_livemode: true, free_trial: false, sub_status: 'active', plan: 'pro', overInvoiceLimit: false },
    settings: { trust_mode: 'draft', paused: false, sender_name: 'Your Studio', stage1_days: 6, stage2_days: 20, late_fee_type: 'none', late_fee_value: 0 },
    sub: { tier: 'pro', status: 'active', interval: 'month', created_at: iso(12), free_trial: false, dev_pro: false },
    tasks: seedTasks.slice(),
    sentEmails: seedSentEmails.slice()
  };

  // ── fetch route table (no network) ──
  window.fetch = function (url, opts) {
    var u = String(url || '');
    var method = ((opts && opts.method) || 'GET').toUpperCase();
    var approve = /^\\/tasks\\/([^/]+)\\/approve$/.exec(u);
    var reject = /^\\/tasks\\/([^/]+)\\/reject$/.exec(u);
    var draft = /^\\/tasks\\/([^/]+)\\/draft$/.exec(u);
    if (u === '/health') return json({ status: 'ok' });
    if (u === '/stats') return json(demoState.stats);
    if (u === '/subscription') return json(demoState.sub);
    if (u === '/settings' && method === 'GET') return json(demoState.settings);
    if (u === '/settings' && method === 'PUT') {
      var put = {};
      try { put = JSON.parse((opts && opts.body) || '{}'); } catch (e) { /* ignore */ }
      for (var k in put) { if (Object.prototype.hasOwnProperty.call(put, k)) { demoState.settings[k] = put[k]; } }
      if ('trust_mode' in put) { try { window.currentTrustMode = put.trust_mode; } catch (e) {} }
      return json(demoState.settings);
    }
    if (u === '/tasks' && method === 'GET') return json(demoState.tasks);
    if (approve) {
      var id = Number(approve[1]);
      demoState.tasks = demoState.tasks.filter(function (t) { return t.id !== id; });
      demoState.sentEmails.push({ customer: 'sample', stage: 1, subject: 'Reminder approved & sent (demo)', daysAgo: 0 });
      demoState.stats.remindersSent += 1;
      demoState.stats.emailsSent += 1;
      return json({ ok: true });
    }
    if (reject) {
      var rj = Number(reject[1]);
      demoState.tasks = demoState.tasks.filter(function (t) { return t.id !== rj; });
      return json({ ok: true });
    }
    if (draft) {
      var df = Number(draft[1]);
      var body = {};
      try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) { /* ignore */ }
      var updated = null;
      demoState.tasks = demoState.tasks.map(function (t) {
        if (t.id === df) { t.draft_body = body.draft_body || t.draft_body; t.draft_subject = body.draft_subject || t.draft_subject; t.status = 'drafted'; updated = t; }
        return t;
      });
      return json({ task: updated || {} });
    }
    if (u === '/summary/send') return json({ skipped: true });
    if (u.indexOf('/billing/') === 0 || u === '/account/delete' || u === '/api/beta/redeem') {
      window.setTimeout(function () { window.alert('Demo Mode: this needs a real Stripe account — nothing here is live. Connect your Stripe account on the real app to do this.'); }, 0);
      return halt('Demo Mode blocks this action.');
    }
    return halt('Demo Mode: network calls are disabled in the demo.');
  };

  // ── Boot (runs after the dashboard script has initialized) ──
  function __demoBoot() {
    // Re-assert (the dashboard's own declarations run later in the script).
    try { window.handoffIf401 = function () { return false; }; } catch (e) {}

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
      demoState.tasks.forEach(function (t) {
        var hasDraft = t.draft_body && String(t.draft_body).trim() !== '';
        if (t.status === 'reviewed') review += 1;
        else if (hasDraft && t.status === 'drafted') draft += 1;
        else if (hasDraft) draft += 1;
        else watch += 1;
      });
      return { watch: watch, draft: draft, review: review, send: demoState.sentEmails.length };
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
        draft: 'Draft Only: every reminder is drafted and waits for your approval — nothing sends without you.',
        semi: 'Semi-Auto: Stage 1 friendly nudges send themselves; Stages 2 and 3 still wait for your approval.',
        full: 'Full Auto: the whole sequence drafts, reviews, and sends on its own. You are notified, never asked.'
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
    // Neutralize links inside the replica that would take a visitor into the
    // REAL app: stat-card drill-downs (/past-due, /reminders), billing portal,
    // account export — all are served by the live backend/site. In the demo
    // they get a friendly alert instead (the dashboard footer links to
    // /support /terms /privacy which the marketing site itself serves — those
    // are fine, but keeping every internal link read-only is simpler and
    // still matches the replica: no demo visitor reaches a real app page).
    try {
      document.addEventListener('click', function (ev) {
        var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
        if (!a) return;
        var href = (a.getAttribute('href') || '').trim();
        if (href.indexOf('/') === 0 && ['/past-due', '/reminders', '/billing/portal', '/billing/checkout', '/account/export', '/stripe/connect', '/oauth/'].some(function (p) { return href.indexOf(p) === 0; })) {
          ev.preventDefault();
          window.alert('Demo Mode: this takes you to the real app — nothing here is live. Connect your Stripe account on the real app to see these.\\n\\n(To keep the demo self-contained, this link is disabled.)');
        }
      });
    } catch (e) {}
    // Keep the stats honest for the demo ("X demo sends (fictional)" — the
    // dashboard's own label says "real sends", which would be untrue here).
    function __demoPatchLabels() {
      var el = document.getElementById('stat-emails');
      if (el) el.textContent = demoState.sentEmails.length + ' demo sends (fictional)';
      var paid = document.getElementById('stat-paid');
      if (paid) paid.textContent = '0 paid · ' + demoState.stats.overdueInvoices + ' overdue (sample data)';
      var inv = document.getElementById('stat-invoices');
      if (inv) inv.textContent = String(9);
      // Stat cards all point at the REAL app pages; in demo mode they become
      // plain status cards (no dead links — matches the replica visually while
      // never leaving the demo).
      ['stat-invoices', 'stat-reminders', 'stat-free-drafts', 'stat-stripe-card'].forEach(function (id) {
        var card = document.getElementById(id);
        if (card) {
          card.className = 'stat-card stat-status';
          var link = card.querySelector && card.querySelector('a');
          if (link) {
            link.removeAttribute('href');
            link.style.cursor = 'default';
            var hint = link.querySelector('.stat-sub-hint');
            if (hint) hint.style.display = 'none';
          }
        }
      });
      // Free-drafts card is a "status" too: keep the link title from sending
      // visitors toward checkout.
      var fdl = document.getElementById('stat-free-drafts-link');
      if (fdl) { fdl.removeAttribute('href'); fdl.title = 'Demo — unlimited drafts on the Pro plan (sample)'; }
      var fdh = document.getElementById('stat-free-drafts-hint');
      if (fdh) fdh.textContent = 'Draft Mode is free forever';
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

    // Keep the parent <iframe> sized to the full dashboard height.
    function __demoPushHeight() {
      try {
        var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 600);
        parent.postMessage({ type: 'cc-demo-height', h: h }, '*');
      } catch (e) {}
    }
    window.setTimeout(__demoPushHeight, 200);
    window.setTimeout(__demoPushHeight, 800);
    window.setInterval(__demoPushHeight, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.setTimeout(__demoBoot, 0); });
  } else {
    window.setTimeout(__demoBoot, 0);
  }
})();
`;

/* Strip the dashboard's own visit-tracking beacon: its POST to /api/track
 * is real page-view tracking for the LIVE dashboard. In the demo, the
 * marketing site's own beacon (site __root.tsx) already records the /demo
 * page view — the embedded dashboard must not double-fire a network call. */
const DASHBOARD_DOC = RAW_DASHBOARD.replace(
  /<script>\s*\(function\(\)\{try\{var p=location\.pathname;[\s\S]*?<\/script>/,
  "<!-- demo: dashboard visit-tracking beacon removed (no /api/track from inside the demo) -->",
).replace(
  "var HANDOFF_URL = '__CC_HANDOFF_URL__';",
  `${DEMO_MODE_SNIPPET}\n    var HANDOFF_URL = '__CC_HANDOFF_URL__';`,
);

export const Route = createFileRoute("/demo")({
  component: Demo,
});

function Demo() {
  const [height, setHeight] = useState(3400);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { type?: string; h?: number } | null;
      if (d && d.type === "cc-demo-height" && typeof d.h === "number") {
        setHeight(Math.max(600, d.h));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <div className="min-h-dvh bg-white">
      <SiteNav />

      {/* ── Custom header (owner's copy, verbatim) ── */}
      <section className="bg-gray-900 text-white">
        <div className="max-w-5xl mx-auto px-6 py-12 text-center">
          <div className="mb-5 flex flex-wrap items-center justify-center gap-3">
            <span className="inline-block rounded-full border border-amber-300/50 bg-amber-400/10 px-4 py-1.5 text-xs font-bold tracking-wide text-amber-300">
              ⚠ Demo Mode — sample data only, nothing sends, nothing is saved
            </span>
            <button
              onClick={() => setResetKey((k) => k + 1)}
              className="inline-block rounded-full border border-gray-600 px-4 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:border-gray-400 hover:text-white"
            >
              ↺ Reset demo
            </button>
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            See the collections pipeline in action
          </h1>
          <p className="mx-auto mt-4 max-w-3xl leading-relaxed text-gray-300">
            This is what an overdue-invoice queue looks like inside Collections
            Copilot. Every customer, invoice, and email below is made-up sample
            data — nothing here is real, nothing sends, and nothing is saved.
            Click an invoice to open it, then try the Trust Mode toggle to see
            how each mode behaves.
          </p>
          <DemoTabs active="pipeline" />
        </div>
      </section>

      {/* ── Middle: exact replica of the real dashboard (DEMO_MODE) ── */}
      <div className="bg-[#F9FAFB]">
        <iframe
          key={resetKey}
          title="Collections Copilot dashboard demo (exact replica)"
          srcDoc={DASHBOARD_DOC}
          className="block w-full border-0"
          style={{ height }}
          scrolling="no"
          tabIndex={-1}
        />
      </div>

      {/* ── Footer: conversion CTA + the site footer ── */}
      <section className="bg-gray-900 py-16 text-white">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight">
            Ready to see it with your own invoices?
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-gray-400">
            The demo above is sample data. Connect your Stripe account and
            Collections Copilot watches your real overdue invoices in the same
            pipeline — read-only at first, and nothing sends without your
            approval.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4">
            <a
              href={SIGNUP_URL}
              className={BTN_PRIMARY}
              style={{ display: "inline-flex" }}
            >
              Connect your Stripe account to start free
            </a>
            <a href="/how-it-works" className={BTN_SECONDARY}>
              How it works
            </a>
          </div>
          <p className="mt-4 text-xs text-gray-500">
            No card required · cancel anytime · your first month is free
          </p>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
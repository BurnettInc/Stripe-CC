import { useEffect, useState } from "react";
import { SiteNav } from "./SiteNav";
import { SiteFooter } from "./SiteFooter";
import { BTN_PRIMARY, BTN_SECONDARY } from "./ui";

/* ══════════════════════════════════════════════════════════════════
 *  Shared DEMO_MODE plumbing for the public /demo* replicas.
 *
 *  Every demo route embeds REAL app HTML (app/src/ui/*.html, bundled via
 *  ?raw) in a same-origin <iframe>, with this shared shim injected at the
 *  top of the page's main inline <script>:
 *
 *    1. window.fetch is replaced with a route table over fictional seeds —
 *       no network, no DB, no Stripe, no email (the table answers every
 *       endpoint the real pages call: /stats /settings /subscription
 *       /tasks /overdue/summary /summary/send /reminders/rows …).
 *    2. Internal app-shell links (/dashboard /past-due /reminders
 *       /messages /copilot-controls /account) navigate the TOP page to the
 *       matching /demo* route via postMessage — the demo stays explorable
 *       inside the sandbox. Everything else same-origin (/terms, /support…)
 *       also navigates the top page, so the marketing site never renders
 *       inside the demo iframe.
 *    3. Real-account actions (/stripe/connect /oauth/ /billing/*
 *       /account/export) keep the "this takes you to the real app" notice
 *       and are always blocked in the sandbox.
 *    4. The parent <iframe> is kept sized via postMessage (cc-demo-height).
 *
 *  This module is the single source of truth for ALL demo routes (/demo,
 *  /demo-reminders, /demo-pastdue, /demo-messages, /demo-copilot-controls,
 *  /demo-account) — old per-route neutralizer copies have been removed.
 * ══════════════════════════════════════════════════════════════════ */

// Demo attribution rides INSIDE state (the install link has no free query
// slot): the client attribution script replaces the CC_VID placeholder with
// `cc_vid=<vid>&src=demo` (URL-encoded as the whole state value), or `src=demo`
// when no cc_vid exists. The backend parses state as URLSearchParams and
// falls back to treating the whole state as the raw cc_vid.
export const SIGNUP_URL =
  "https://marketplace.stripe.com/apps/install/link/com.stripecollectionscopilot.app?redirect_uri=https%3A%2F%2Fstripe-cc-production.up.railway.app%2Foauth%2Fcallback&state=src%3Ddemo";

/* Real app shell paths → public demo routes. A link whose href starts with
 * the "from" path (e.g. /messages#sent, /past-due?status=paid) navigates the
 * top-level page to the matching demo route (hash preserved). */
export const DEMO_NAV_MAP: ReadonlyArray<readonly [string, string]> = [
  ["/dashboard", "/demo"],
  ["/past-due", "/demo-pastdue"],
  ["/reminders", "/demo-reminders"],
  ["/messages", "/demo-messages"],
  ["/copilot-controls", "/demo-copilot-controls"],
  ["/account", "/demo-account"],
];

/* Paths that genuinely require a real Stripe connection or real money —
 * these always keep the "real app" notice inside the sandbox. */
export const REAL_ACCOUNT_HREFS: ReadonlyArray<string> = [
  "/stripe/connect",
  "/oauth/",
  "/billing/",
  "/account/export",
];

/* Static HTML fragment served by the shim's /reminders/rows route (the
 * messages.html "Sent" tab injects it into #sent-list, exactly like the real
 * backend endpoint). Same row classes as the real fragment so the page's own
 * table styles, "View email" toggles and client-side sorting all work. */
const _esc = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const SENT_ROWS_FRAGMENT = (() => {
  const row = (
    id: number, invoiceId: number, customer: string, email: string,
    amount: number, stage: number, sentIso: string, subject: string, body: string,
    engagement: string,
  ): string =>
    `<tr>` +
    `<td class="cell-toggle">` +
    `<button type="button" class="email-toggle" data-id="${id}" aria-expanded="false">View email</button>` +
    `<div class="email-body" id="emailbody-${id}" hidden>` +
    `<dl class="email-meta">` +
    `<div class="meta-row"><dt>From</dt><dd>"Your Studio" &lt;reminders@mail.getcollectionscopilot.com&gt;</dd></div>` +
    `<div class="meta-row"><dt>Reply-To</dt><dd>reply+${invoiceId}@replies.getcollectionscopilot.com</dd></div>` +
    `<div class="meta-row"><dt>Subject</dt><dd>${_esc(subject)}</dd></div>` +
    `</dl>` +
    `<pre class="email-pre">${_esc(body + "\n\n---\nDemo sample — no real email was sent from the demo.")}</pre>` +
    `</div>` +
    `</td>` +
    `<td><div class="cell-strong">${_esc(customer)}</div>` +
    `<div class="cell-muted" style="font-size:0.75rem;">${_esc(email)}</div></td>` +
    `<td class="cell-amount" data-sort="${amount}">${money(amount)}</td>` +
    `<td data-sort="${stage}"><span class="chip chip-stage st${stage}">Stage ${stage}</span></td>` +
    `<td class="cell-muted" data-sort="${_esc(sentIso)}">${_esc(sentIso.slice(0, 10))}</td>` +
    `<td data-sort="${engagement === "clicked" ? 2 : engagement === "opened" ? 1 : 0}">` +
    `<span class="chip chip-engagement chip-engagement-${engagement}">${engagement === "clicked" ? "Opened &amp; clicked" : engagement === "opened" ? "Opened" : "Not opened"}</span></td>` +
    `<td data-sort="${_esc(subject)}">${_esc(subject)}</td>` +
    `<td><span class="chip chip-sent">Sent</span></td>` +
    `</tr>`;
  const rows = [
    row(501, 18, "Maya Thompson", "maya@thompsonstudio.com", 96000, 2, "2026-09-06T09:00:00.000Z", "Following up — invoice #1044", "Hi Maya,\n\nJust following up on invoice #1044 ($960) — it is now a few days past due. If it is already on its way, no need to reply; if something does not add up, happy to sort it out.\n\nLet me know either way?", "opened"),
    row(502, 19, "Daniel Kim", "daniel@kimdesign.co", 76000, 3, "2026-08-26T09:00:00.000Z", "Final notice — invoice #1055", "Hi Daniel,\n\nThis is the final notice for invoice #1055 ($760), now more than three weeks overdue. Two reminders have gone out with no payment received, and per our payment terms this invoice needs to be settled without further delay.\n\nPlease arrange payment now — and if there is a dispute or a hardship, contact us today so we can find a solution before any further steps are taken.", "opened"),
    row(503, 19, "Daniel Kim", "daniel@kimdesign.co", 76000, 2, "2026-08-12T09:00:00.000Z", "Following up — invoice #1055", "Hi Daniel,\n\nFollowing up on invoice #1055 ($760) — it is now a few days past due. If it is already on its way, you can ignore this; if there is a hiccup on your end, happy to work something out.\n\nLet me know either way?", "none"),
    row(504, 19, "Daniel Kim", "daniel@kimdesign.co", 76000, 1, "2026-07-30T09:00:00.000Z", "Quick nudge — invoice #1055", "Hi Daniel,\n\nQuick nudge that invoice #1055 ($760) slipped past its due date — no rush if it has been a busy one.\n\nIf it is already on its way, no need to reply. Cheers!", "clicked"),
  ].join("");
  return (
    `<div class="table-wrap"><table>` +
    `<thead><tr><th scope="col">Email</th><th scope="col">Customer</th>` +
    `<th class="sortable" data-sort-key="amount" scope="col">Amount<span class="sort-indicator"></span></th>` +
    `<th class="sortable" data-sort-key="stage" scope="col">Stage<span class="sort-indicator"></span></th>` +
    `<th class="sortable" data-sort-key="sent_at" scope="col">Sent at<span class="sort-indicator"></span></th>` +
    `<th class="sortable" data-sort-key="engagement" scope="col">Engagement<span class="sort-indicator"></span></th>` +
    `<th class="sortable" data-sort-key="subject" scope="col">Subject<span class="sort-indicator"></span></th>` +
    `<th scope="col">Result</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
})();

/* ── DEMO_MODE shim ──────────────────────────────────────────────────
 * Inserted at the TOP of each embedded app page's main inline <script>, so
 * it runs before the page's own init calls. window.fetch is replaced with a
 * route table over fictional seeds; anything not on the table fails closed.
 * Navigates the top-level page for internal shell links, blocks real-account
 * actions with the honest notice, and keeps the parent iframe sized. */
const NAV_JSON = JSON.stringify(DEMO_NAV_MAP);
const REAL_JSON = JSON.stringify(REAL_ACCOUNT_HREFS);
const ROWS_JSON = JSON.stringify(SENT_ROWS_FRAGMENT);

export const DEMO_MODE_SNIPPET = `
// ─────────────────────────────────────────────────────────────────────
// DEMO_MODE (injected by site/src/components/demoShim.tsx) — this copy of
// the real app page runs against fictional in-memory seed data only. No
// network, no DB, no Stripe, no email. Refreshing the page resets it.
// ─────────────────────────────────────────────────────────────────────
(function () {
  var DEMO_NAV = ${NAV_JSON};
  var REAL_ACCOUNT = ${REAL_JSON};
  var REMINDERS_ROWS = ${ROWS_JSON};
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
    { id: 11, customer_name: 'Avery Chen', company: 'Chen Studio', stage: 1, status: 'pending', amount_cents: 45000, currency: 'usd', due_date: iso(5), days_overdue: 5, created_at: iso(5), draft_subject: '', draft_body: '', invoice_status: 'open' },
    { id: 12, customer_name: 'Leo Fischer', company: 'Fischer Studio', stage: 1, status: 'pending', amount_cents: 72000, currency: 'usd', due_date: iso(3), days_overdue: 3, created_at: iso(3), draft_subject: '', draft_body: '', invoice_status: 'open' },
    { id: 13, customer_name: 'Marcus Webb', company: 'Webb Digital', stage: 1, status: 'drafted', amount_cents: 125000, currency: 'usd', due_date: iso(6), days_overdue: 6, created_at: iso(6), draft_subject: 'Quick nudge — invoice #1053', draft_body: 'Hi Marcus,\\n\\nHope the site relaunch went well this week. Just a quick nudge that invoice #1053 ($1,250) slipped past its due date — no rush if it has been a busy one.\\n\\nIf it is already on its way, no need to reply. Cheers!', invoice_status: 'open' },
    { id: 14, customer_name: 'Sofia Reyes', company: 'Reyes Collective', stage: 2, status: 'drafted', amount_cents: 64000, currency: 'usd', due_date: iso(9), days_overdue: 9, created_at: iso(9), draft_subject: 'Following up — invoice #1062', draft_body: 'Hi Sofia,\\n\\nFollowing up on invoice #1062 ($640) — it is now a few days past due. If it is already on its way, you can ignore this; if there is a hiccup on your end, happy to work something out.\\n\\nLet me know either way?', invoice_status: 'open' },
    { id: 15, customer_name: 'Priya Natarajan', company: 'Natarajan Design', stage: 2, status: 'drafted', amount_cents: 280000, currency: 'usd', due_date: iso(18), days_overdue: 18, created_at: iso(18), draft_subject: 'Overdue — invoice #1047', draft_body: 'Hi Priya,\\n\\nI wanted to check in personally about invoice #1047 ($2,800), which is now 18 days past its due date. We are past the friendly-reminder stage, so I would really appreciate it if you could arrange payment this week.\\n\\nIf there is a billing question or a specific blocker, reply and I will sort it out right away — otherwise our standard reminders will keep running.', invoice_status: 'open' },
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
  // Exposed for page-specific demo boots (dashboard pipeline strip/labels).
  try { window.__demoState = demoState; } catch (e) {}

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
    if (u === '/overdue/summary' && method === 'GET') return json({ counts: { total: demoState.tasks.length, active: demoState.tasks.length, paused: 0, awaiting_approval: 0 }, invoices: demoState.tasks.map(function (t) { return { id: t.id, customer_name: t.customer_name, amount_due: t.amount_cents, currency: t.currency, days_overdue: t.days_overdue, stage: t.stage, status: 'active', pause_reason: null }; }), recent_reminders: [] });
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
    if (u === '/summary/send' && method === 'POST') return json({ skipped: true });
    // messages.html "Sent" tab injects this fragment into #sent-list.
    if (u === '/reminders/rows' && method === 'GET') {
      return new Response(REMINDERS_ROWS, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    // list-page stage overrides / pause / resume fail closed WITHOUT the
    // generic alert (the page's own fail() path then shows the translated
    // demo message) — no reload, no navigation, seed state untouched.
    if (u === '/tasks/pause' || u === '/tasks/resume' || /^\\/invoices\\/\\d+\\/stage$/.test(u)) {
      return halt('Demo Mode: this is sample data — changes are not saved here.');
    }
    // Real-money / real-account endpoints keep the notice and never resolve.
    if (u.indexOf('/billing/') === 0 || u === '/account/delete' || u === '/api/beta/redeem') {
      window.setTimeout(function () {
        _alert('Demo Mode: this needs a real Stripe account or real billing connection — nothing here is live. Install the app and connect your Stripe account on the real app to do this.');
      }, 0);
      return halt('Demo Mode blocks this action.');
    }
    return halt('Demo Mode: network calls are disabled in the demo.');
  };

  // The list page's stage-override handler alerts "Could not update the
  // escalation stage." when its PUT fails — translate that into an honest
  // demo message instead of looking like a product bug. All shim alerts go
  // through the captured _alert so they fire even if a page later replaces
  // window.alert.
  var _alert = window.alert;
  window.alert = function (m) {
    if (typeof m === 'string' && m.indexOf('Could not update the escalation stage') === 0) {
      _alert('Demo Mode: this is sample data — stage overrides are not saved here. Connect your Stripe account on the real app to manage real invoices.');
    } else {
      _alert(m);
    }
  };

  // ── Boot (runs after the page's own script has initialized) ──
  function __demoBoot() {
    // The embedded pages bounce to HANDOFF_URL on a 401 — the demo never
    // returns 401, and the demo must never navigate anywhere real.
    try { window.handoffIf401 = function () { return false; }; } catch (e) {}

    // Internal links: shell tabs / drill-downs navigate the TOP page to the
    // matching /demo* route (never the iframe, never the real app).
    // Real-account links keep the notice and are always blocked.
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('a') : null;
      if (!a) return;
      var href = (a.getAttribute('href') || '').trim();
      if (href.indexOf('#') === 0 || href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0 || href.indexOf('data:') === 0 || /^https?:/i.test(href)) return;
      if (href.indexOf('/') !== 0) return;
      // Real-account actions first (they always keep the popup) — never navigate.
      for (var i = 0; i < REAL_ACCOUNT.length; i++) {
        if (href.indexOf(REAL_ACCOUNT[i]) === 0) {
          ev.preventDefault();
          _alert('Demo Mode: this needs a real Stripe account or real billing connection — nothing here is live. Install the app and connect your Stripe account on the real app to do this.');
          return;
        }
      }
      // Internal app-shell links → matching demo view (hash preserved so
      // /messages#sent lands on the demo Sent tab, which the boots re-select).
      for (var j = 0; j < DEMO_NAV.length; j++) {
        var from = DEMO_NAV[j][0];
        var to = DEMO_NAV[j][1];
        if (href === from || href.indexOf(from) === 0) {
          var hash = '';
          var hi = href.indexOf('#');
          if (hi !== -1) hash = href.slice(hi);
          ev.preventDefault();
          try { parent.postMessage({ type: 'cc-demo-nav', path: to + hash }, '*'); } catch (e) {}
          return;
        }
      }
      // Any other same-origin link (/terms, /support, /privacy, /how-it-works…)
      // also navigates the TOP page, so the marketing site route loads at
      // top level instead of rendering inside the demo iframe.
      ev.preventDefault();
      try { parent.postMessage({ type: 'cc-demo-nav', path: href }, '*'); } catch (e) {}
    });

    // #sent deep link: /messages#sent → /demo-messages#sent. The embedded
    // messages.html runs selectTab() itself during parse; re-select the Sent
    // tab once the page is up (no-op on every other page).
    try {
      var ph = window.parent && window.parent.location && window.parent.location.hash;
      if (ph === '#sent' && typeof window.selectTab === 'function') { window.selectTab('sent'); }
    } catch (e) {}

    // Keep the parent <iframe> sized to the full page height.
    function __demoPushHeight() {
      try {
        var h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 600);
        parent.postMessage({ type: 'cc-demo-height', h: h }, '*');
      } catch (e) {}
    }
    window.setTimeout(__demoPushHeight, 200);
    window.setTimeout(__demoPushHeight, 800);
    window.setInterval(__demoPushHeight, 3000);

    // Page-specific extra boot (dashboard pipeline strip, honest stat
    // labels, summary-copy patch — defined by the /demo route).
    try { if (typeof window.__demoExtraBoot === 'function') { window.__demoExtraBoot(); } } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.setTimeout(__demoBoot, 0); });
  } else {
    window.setTimeout(__demoBoot, 0);
  }
})();
`;

/* Demo-only iframe sizing fix: the REAL app pages legitimately fill the
 * viewport (body/.cc-shell min-height:100vh, pinned .cc-sidebar), but inside
 * the <iframe srcdoc> those vh units resolve against the iframe's OWN height,
 * so documentElement.scrollHeight never drops below the current frame size —
 * leaving a large empty band under the last card. Neutralize the vh stretch
 * in the demo copy only; the real app pages (app/src/ui/*.html) are
 * untouched. */
export const DEMO_IFRAME_FIX =
  "<!-- demo-only: neutralize the page's viewport-height stretch inside the iframe so the parent can measure true content height --><style>\n" +
  "      body { min-height: 0 !important; }\n" +
  "      .cc-shell { min-height: 0 !important; }\n" +
  "      .cc-sidebar { height: auto !important; max-height: none !important; }\n" +
  "    </style>";

/* Strip the page's own visit-tracking beacon: its POST to /api/track is real
 * page-view tracking for the LIVE app pages. In the demo, the marketing
 * site's own beacon (site __root.tsx) already records the /demo* page view —
 * the embedded page must not double-fire a network call. Pages without the
 * beacon (messages.html) are unaffected (regex simply doesn't match). */
export const BEACON_RE =
  /<script>\s*\(function\(\)\{try\{var p=location\.pathname;[\s\S]*?<\/script>/;

/* Anchor where the shim is injected: right before the page's own
 * session-handoff declaration, i.e. at the very top of the main inline
 * <script>. Present in dashboard/messages/copilot-controls/account. */
export const HANDOFF_ANCHOR = "var HANDOFF_URL = '__CC_HANDOFF_URL__';";

/* list-page.html instead anchors on its main inline <script> (it has no
 * HANDOFF_URL declaration). The injection point must be INSIDE the script
 * block, so the anchor is the comment line itself (NOT the <script> tag —
 * buildDemoDoc puts the shim before the anchor, and a shim outside <script>
 * would be inert text). */
export const LIST_PAGE_SCRIPT_ANCHOR = "    // Client-side table sorting";

/* Build the demo document for an embedded app page: strip the visit beacon,
 * inject the shared DEMO_MODE shim at the top of the main inline script,
 * and neutralize the viewport-height stretch. */
export function buildDemoDoc(rawHtml: string, anchor: string): string {
  return rawHtml
    .replace(BEACON_RE, "<!-- demo: page visit-tracking beacon removed (no /api/track from inside the demo) -->")
    .replace(anchor, `${DEMO_MODE_SNIPPET}\n    ${anchor}`)
    .replace("</head>", DEMO_IFRAME_FIX + "</head>");
}

/* ── Parent page: listen for cc-demo-nav postMessages from the embedded
 * iframe and navigate the top-level marketing-site route. */
export function useDemoNav(): void {
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { type?: string; path?: string } | null;
      if (d && d.type === "cc-demo-nav" && typeof d.path === "string" && d.path.startsWith("/")) {
        if (d.path === window.location.pathname + window.location.hash) return;
        window.location.assign(d.path);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);
}

/* ── Shared demo iframe: height-sync + nav listener + reset key. Every demo
 * route renders the embedded app page through this component. */
export function DemoFrame({
  srcDoc,
  resetKey,
  title,
  minHeight = 620,
}: {
  srcDoc: string;
  resetKey: number;
  title: string;
  minHeight?: number;
}) {
  const [height, setHeight] = useState(minHeight);
  useDemoNav();

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
    <iframe
      key={resetKey}
      title={title}
      srcDoc={srcDoc}
      className="block w-full border-0"
      style={{ height }}
      scrolling="no"
      tabIndex={-1}
    />
  );
}

/* ── Demo-mode sub-nav (all /demo* pages) — matches the app shell's own
 * navigation labels: Dashboard / Invoices / Messages / Copilot Controls /
 * Account, plus the Reminders drill-down page. */
export type DemoTabKey =
  | "dashboard"
  | "invoices"
  | "reminders"
  | "messages"
  | "controls"
  | "account";

const DEMO_TABS: Array<{ key: DemoTabKey; href: string; label: string }> = [
  { key: "dashboard", href: "/demo", label: "Dashboard" },
  { key: "invoices", href: "/demo-pastdue", label: "Invoices" },
  { key: "messages", href: "/demo-messages", label: "Messages" },
  { key: "controls", href: "/demo-copilot-controls", label: "Copilot Controls" },
  { key: "account", href: "/demo-account", label: "Account" },
  { key: "reminders", href: "/demo-reminders", label: "Reminders" },
];

export function DemoTabs({ active }: { active: DemoTabKey }) {
  return (
    <div className="mx-auto mt-7 inline-flex flex-wrap justify-center rounded-full border border-gray-700 bg-gray-800/60 p-1 text-sm font-semibold">
      {DEMO_TABS.map((t) => (
        <a
          key={t.key}
          href={t.href}
          aria-current={active === t.key ? "page" : undefined}
          className={`rounded-full px-5 py-2 transition-colors ${
            active === t.key
              ? "bg-indigo-600 text-white"
              : "text-gray-300 hover:text-white"
          }`}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

/* ── Full marketing-page chrome shared by every /demo* route: header with
 * Demo Mode banner + reset, sub-nav, the embedded replica, conversion CTA,
 * and the site footer. */
export function DemoPageShell({
  banner,
  heading,
  body,
  activeTab,
  frameTitle,
  srcDoc,
  minHeight = 620,
}: {
  banner: string;
  heading: string;
  body: string;
  activeTab: DemoTabKey;
  frameTitle: string;
  srcDoc: string;
  minHeight?: number;
}) {
  const [resetKey, setResetKey] = useState(0);

  return (
    <div className="min-h-dvh bg-white">
      <SiteNav />

      {/* ── Custom header (Demo Mode banner + owner-style copy) ── */}
      <section className="bg-gray-900 text-white">
        <div className="max-w-5xl mx-auto px-6 py-12 text-center">
          <div className="mb-5 flex flex-wrap items-center justify-center gap-3">
            <span className="inline-block rounded-full border border-amber-300/50 bg-amber-400/10 px-4 py-1.5 text-xs font-bold tracking-wide text-amber-300">
              {banner}
            </span>
            <button
              onClick={() => setResetKey((k) => k + 1)}
              className="inline-block rounded-full border border-gray-600 px-4 py-1.5 text-xs font-semibold text-gray-300 transition-colors hover:border-gray-400 hover:text-white"
            >
              ↺ Reset demo
            </button>
          </div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{heading}</h1>
          <p className="mx-auto mt-4 max-w-3xl leading-relaxed text-gray-300">{body}</p>
          <DemoTabs active={activeTab} />
        </div>
      </section>

      {/* ── Middle: exact replica of the real app page (DEMO_MODE) ── */}
      <div className="bg-[#F9FAFB]">
        <DemoFrame key={resetKey} title={frameTitle} srcDoc={srcDoc} minHeight={minHeight} />
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
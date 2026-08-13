/**
 * Unit tests for the landing-page visit-tracking snippet + the /admin
 * own-visit skip toggle (tracking cleanup, 2026-08-13).
 *
 * The snippet is inline JS in the site root layout
 * (../site/src/routes/__root.tsx). This test extracts the ACTUAL shipped
 * snippet string and executes it in a sandbox with stubbed localStorage /
 * location / navigator / document / crypto — so it proves the real code, not
 * a re-implementation.
 *
 * Proves (snippet):
 *   (a) normal page ("/", "/about") sends one beacon to /api/track with
 *       visitor_id/page/referrer/utm/ts and creates cc_vid in localStorage
 *   (b) cc_vid is reused when already present
 *   (c) localStorage cc_skip === "1" → NO beacon (and no cc_vid created)
 *   (d) utility pages /support, /privacy, /terms (+ /admin defensively, and
 *       any subpath) → NO beacon
 *   (e) utm params flow through; referrer truncated to 500 chars
 *   (f) XHR fallback used when navigator.sendBeacon is missing
 *
 * Proves (admin.html toggle):
 *   (g) toggle button + cc_skip localStorage write/clear present; no <form>
 *       (works without page reload); UI note text present
 *
 * Run:  cd app && bun run test-tracking-snippet.ts
 * (also copied to /home/team/shared/app/test-tracking-snippet.ts — runs
 * against the live copy's ../site/src/routes/__root.tsx the same way)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootTsx = readFileSync(join(import.meta.dir, "..", "site", "src", "routes", "__root.tsx"), "utf-8");
const adminHtml = readFileSync(join(import.meta.dir, "src", "ui", "admin.html"), "utf-8");

// Extract the inline snippet JS: the JSX string literal after __html: — the
// snippet contains no double quotes, so a simple [^"]* capture is exact.
const m = rootTsx.match(/__html:\s*"([^"]*)"/);
if (!m) {
  console.error("FAIL  could not extract tracking snippet from __root.tsx");
  process.exit(1);
}
const SNIPPET = m[1];

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}  ${detail}`); }
}

interface RunOpts {
  pathname: string;
  search?: string;
  skip?: boolean;
  existingVid?: string;
  referrer?: string;
  noSendBeacon?: boolean;
  uuid?: () => string;
}

interface Beacon { url: string; bodyText: Promise<string>; }
interface XhrCall { opened: [string, string]; sent: boolean; }

async function runSnippet(opts: RunOpts) {
  const store = new Map<string, string>();
  if (opts.existingVid) store.set("cc_vid", opts.existingVid);
  if (opts.skip) store.set("cc_skip", "1");

  const localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const beacons: Beacon[] = [];
  const xhrCalls: XhrCall[] = [];
  const navigator: Record<string, unknown> = opts.noSendBeacon
    ? {}
    : {
        sendBeacon: (url: string, blob: Blob) => {
          beacons.push({ url, bodyText: blob.text() });
          return true;
        },
      };
  class XHR {
    opened: [string, string] = ["", ""];
    sent = false;
    open(method: string, url: string) { this.opened = [method, url]; }
    send(blob: Blob) {
      this.sent = true;
      xhrCalls.push({ opened: this.opened, sent: true });
      void blob.text();
    }
  }
  const document = { referrer: opts.referrer ?? "" };
  const crypto = { randomUUID: opts.uuid ?? (() => "fixed-uuid-0001") };
  const location = { pathname: opts.pathname, search: opts.search ?? "" };

  const fn = new Function(
    "localStorage", "location", "navigator", "document", "crypto",
    "URLSearchParams", "Blob", "XMLHttpRequest",
    SNIPPET
  );
  fn(localStorage, location, navigator, document, crypto, URLSearchParams, Blob, XHR);

  const bodies = await Promise.all(beacons.map((b) => b.bodyText));
  return {
    store,
    beacons: bodies.map((t, i) => ({ url: beacons[i].url, body: JSON.parse(t) })),
    xhrCalls,
    vid: store.get("cc_vid") ?? null,
  };
}

// ── (a) normal pages beacon once with the full payload + cc_vid created ──
const normal = await runSnippet({ pathname: "/" });
check("landing / sends exactly one beacon", normal.beacons.length === 1, `got ${normal.beacons.length}`);
check("beacon URL is /api/track", normal.beacons[0]?.url === "/api/track", normal.beacons[0]?.url);
check("beacon body.page is /", normal.beacons[0]?.body.page === "/", JSON.stringify(normal.beacons[0]?.body));
check("cc_vid created on first visit", typeof normal.vid === "string" && normal.vid.length > 0, String(normal.vid));
check("beacon carries the created visitor_id", normal.beacons[0]?.body.visitor_id === normal.vid, String(normal.beacons[0]?.body.visitor_id));
check("beacon carries referrer", normal.beacons[0]?.body.referrer === "", `got ${normal.beacons[0]?.body.referrer}`);
check("beacon carries a parseable ts", !Number.isNaN(Date.parse(normal.beacons[0]?.body.ts)), String(normal.beacons[0]?.body.ts));
check("empty utm fields are empty strings", normal.beacons[0]?.body.utm_source === "" && normal.beacons[0]?.body.utm_medium === "", JSON.stringify(normal.beacons[0]?.body));

const about = await runSnippet({ pathname: "/about" });
check("real page /about still beacons", about.beacons.length === 1, `got ${about.beacons.length}`);

// ── (b) cc_vid reused ──
const reused = await runSnippet({ pathname: "/", existingVid: "abc-123" });
check("cc_vid reused when present", reused.beacons[0]?.body.visitor_id === "abc-123", String(reused.beacons[0]?.body.visitor_id));

// ── (c) cc_skip === '1' → no beacon, no vid created ──
const skipped = await runSnippet({ pathname: "/", skip: true });
check("cc_skip=1 → no beacon on /", skipped.beacons.length === 0, `got ${skipped.beacons.length}`);
check("cc_skip=1 → no cc_vid created", skipped.vid === null, String(skipped.vid));
const skippedAbout = await runSnippet({ pathname: "/about", skip: true });
check("cc_skip=1 → no beacon on real pages either", skippedAbout.beacons.length === 0, `got ${skippedAbout.beacons.length}`);

// ── (d) utility pages never beacon ──
for (const page of ["/support", "/privacy", "/terms", "/admin", "/support/", "/support/anything", "/privacy/x", "/terms/y", "/admin/z"]) {
  const r = await runSnippet({ pathname: page });
  check(`utility page ${page} → no beacon`, r.beacons.length === 0, `got ${r.beacons.length}`);
}
// not-utility lookalikes still track (no such routes, but prefix logic must not over-match)
const supportLookalike = await runSnippet({ pathname: "/supporters" });
check("lookalike /supporters still beacons", supportLookalike.beacons.length === 1, `got ${supportLookalike.beacons.length}`);

// ── (e) utm params + referrer truncation ──
const utm = await runSnippet({
  pathname: "/",
  search: "?utm_source=producthunt&utm_medium=social&utm_campaign=launch&utm_content=launch-post-1",
  referrer: "x".repeat(700),
});
check("utm_source flows through", utm.beacons[0]?.body.utm_source === "producthunt", String(utm.beacons[0]?.body.utm_source));
check("utm_medium flows through", utm.beacons[0]?.body.utm_medium === "social", String(utm.beacons[0]?.body.utm_medium));
check("utm_campaign flows through", utm.beacons[0]?.body.utm_campaign === "launch", String(utm.beacons[0]?.body.utm_campaign));
check("utm_content flows through (post-level tag)", utm.beacons[0]?.body.utm_content === "launch-post-1", String(utm.beacons[0]?.body.utm_content));
check("missing utm_content on plain page is an empty string", normal.beacons[0]?.body.utm_content === "", String(normal.beacons[0]?.body.utm_content));
check("referrer truncated to 500 chars", utm.beacons[0]?.body.referrer.length === 500, String(utm.beacons[0]?.body.referrer?.length));

// ── (f) XHR fallback when sendBeacon is unavailable ──
const xhr = await runSnippet({ pathname: "/", noSendBeacon: true });
check("XHR fallback sends once to /api/track", xhr.xhrCalls.length === 1 && xhr.xhrCalls[0].opened[0] === "POST" && xhr.xhrCalls[0].opened[1] === "/api/track", JSON.stringify(xhr.xhrCalls));
check("XHR fallback still creates cc_vid", typeof xhr.vid === "string" && xhr.vid.length > 0, String(xhr.vid));

// ── (g) admin.html toggle ──
check("admin has skip toggle button", adminHtml.includes('id="skipToggle"') && adminHtml.includes("Stop counting my visits") && adminHtml.includes("Count my visits again"));
check("admin toggle writes cc_skip to localStorage", adminHtml.includes('localStorage.setItem("cc_skip", "1")') && adminHtml.includes('localStorage.removeItem("cc_skip")'));
check("admin toggle has no <form> (no page reload)", !/<form/i.test(adminHtml));
check("admin note explains the behavior", adminHtml.includes("won't be counted in the funnel"));

console.log(failures === 0 ? "\nAll tracking-snippet tests passed." : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

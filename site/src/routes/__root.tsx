import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import appCss from "~/styles/app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "CollectionsCopilot — Recover invoices faster" },
      { name: "description", content: "The simplest AI collections assistant for solo Stripe users. One-click connect, personalized escalating reminders, configurable Trust Mode. Get paid without lifting a finger." },
      { property: "og:title", content: "CollectionsCopilot — Recover invoices faster" },
      { property: "og:description", content: "The simplest AI collections assistant for solo Stripe users. One-click connect, personalized escalating reminders, configurable Trust Mode. Get paid without lifting a finger." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://www.getcollectionscopilot.com/" },
      { property: "og:image", content: "https://www.getcollectionscopilot.com/og-image.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "CollectionsCopilot — AI collections assistant for Stripe" },
      { property: "og:site_name", content: "CollectionsCopilot" },
      { property: "og:locale", content: "en_US" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "CollectionsCopilot — Recover invoices faster" },
      { name: "twitter:description", content: "The simplest AI collections assistant for solo Stripe users. One-click connect, personalized escalating reminders, configurable Trust Mode. Get paid without lifting a finger." },
      { name: "twitter:image", content: "https://www.getcollectionscopilot.com/og-image.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/icon.svg" },
    ],
  }),
  notFoundComponent: () => <div>Page not found</div>,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        {/* Internal page-visit tracking (owner 2026-08-12; cleanup 2026-08-13;
            utm_content added 2026-08-13; UA sent 2026-08-26):
            first-party, internal-only analytics. A per-browser
            UUID in localStorage identifies the visitor; each page load POSTs
            {visitor_id, page, referrer, utm_source, utm_medium, utm_campaign,
            utm_content, ua, ts} to /api/track. `ua` (navigator.userAgent) is
            sent as a fallback — the server prefers its own User-Agent request
            header, and derives+MASKES the IP from a proxy header itself (the
            client never sends an IP). All utm_* values (including
            utm_content) are read from the page URL, like utm_source already
            was — a URL-provided attribution tag, not a privacy change. No beacon
            is sent when (a) localStorage cc_skip === "1" (owner toggle on
            /admin — "Stop counting my visits"), or (b) the path is a utility
            page (/support, /privacy, /terms — plus /admin defensively) so
            support hits and the owner's own browsing don't pollute the funnel. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var p=location.pathname;if(localStorage.getItem('cc_skip')==='1')return;if(p==='/support'||p==='/privacy'||p==='/terms'||p==='/admin'||p.indexOf('/support/')===0||p.indexOf('/privacy/')===0||p.indexOf('/terms/')===0||p.indexOf('/admin/')===0)return;var k='cc_vid',v=localStorage.getItem(k);if(!v){v=(crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return(c==='x'?r:(r&0x3|0x8)).toString(16)}));localStorage.setItem(k,v)}var q=new URLSearchParams(location.search),p2={visitor_id:v,page:p,referrer:document.referrer.slice(0,500),utm_source:q.get('utm_source')||'',utm_medium:q.get('utm_medium')||'',utm_campaign:q.get('utm_campaign')||'',utm_content:q.get('utm_content')||'',ua:navigator.userAgent,ts:new Date().toISOString()},b=new Blob([JSON.stringify(p2)],{type:'application/json'});if(navigator.sendBeacon){navigator.sendBeacon('/api/track',b)}else{var x=new XMLHttpRequest();x.open('POST','/api/track',true);x.send(b)}}catch(e){}})();",
          }}
        />
        {/* Install CTA visitor attribution (owner 8/25, follow-up to the
            admin-dashboard visitor→merchant tracing): append the SAME per-browser
            visitor_id from localStorage `cc_vid` (the tracking snippet above) as
            ?cc_vid=<id> on every "Connect Stripe" / "Install from the marketplace"
            CTA that points at the install endpoint, so the visitor is attributed
            when they become a merchant. Rewrites ALL matching anchors (the
            landing page has several CTAs wired to INSTALL_URL) — a no-op when no
            visitor_id exists or no matching anchor is found. The install flow
            carries the value through to the merchant row (referrer-based tracing —
            no UTM link changes, per the owner decision). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var v=localStorage.getItem('cc_vid');if(!v)return;var base='https://stripe-cc-production.up.railway.app/oauth/install';function fix(){document.querySelectorAll('a[href]').forEach(function(a){var h=a.getAttribute('href')||'';if(h.indexOf(base)===0){var u=new URL(h);if(!u.searchParams.has('cc_vid')){u.searchParams.set('cc_vid',v);a.setAttribute('href',u.toString())}}})}if(document.readyState!=='loading'){fix()}else{document.addEventListener('DOMContentLoaded',fix)}}catch(e){}})();",
          }}
        />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

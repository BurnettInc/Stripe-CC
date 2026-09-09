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
      { title: "Collections Copilot — Recover invoices faster" },
      { name: "description", content: "The simplest AI collections assistant for solo Stripe users. One-click connect, personalized escalating reminders, configurable Trust Mode. Get paid without lifting a finger." },
      { property: "og:title", content: "Collections Copilot — Recover invoices faster" },
      { property: "og:description", content: "The simplest AI collections assistant for solo Stripe users. One-click connect, personalized escalating reminders, configurable Trust Mode. Get paid without lifting a finger." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://www.getcollectionscopilot.com/" },
      { property: "og:image", content: "https://www.getcollectionscopilot.com/og-image.png" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Collections Copilot — AI collections assistant for Stripe" },
      { property: "og:site_name", content: "Collections Copilot" },
      { property: "og:locale", content: "en_US" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Collections Copilot — Recover invoices faster" },
      { name: "twitter:description", content: "The simplest AI collections assistant for solo Stripe users. One-click connect, personalized escalating reminders, configurable Trust Mode. Get paid without lifting a finger." },
      { name: "twitter:image", content: "https://www.getcollectionscopilot.com/og-image.png" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/png", href: "/collectionscopilot-logo.png" },
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
        {/* Install-link attribution (owner 9/9: Stripe-hosted install link —
            first hop marketplace.stripe.com): every marketing CTA points at the
            Stripe-hosted install link with a CC_VID state placeholder. This
            script fills the placeholder with the per-browser visitor_id from
            localStorage `cc_vid` (set by the tracking snippet above): plain
            CTAs get state=<vid>; demo CTAs (href carries src=demo inside the
            state value) get state=cc_vid=<vid>&src=demo (URL-encoded as the
            whole state value). When no cc_vid exists the href is left as-is
            (Stripe still installs; attribution just absent). Matching is on
            the install-link URL only — the /oauth/install/start direct path
            is never touched. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var v=localStorage.getItem('cc_vid')||'';var m='marketplace.stripe.com/apps/install/link/';var d='__cc_done__';function st(a,isDemo){var cur=a.getAttribute('href')||'';var u;try{u=new URL(cur)}catch(e){return}var sv=u.searchParams.get('state')||'';var nv;if(isDemo){nv=v?('cc_vid='+v+'&src=demo'):'src=demo'}else{if(!v)return;nv=v}if(sv===nv)return;u.searchParams.set('state',nv);a.setAttribute('href',u.toString())}function fix(){var els=document.querySelectorAll('a[href]');for(var i=0;i<els.length;i++){var a=els[i];if(a[d])continue;var h=a.getAttribute('href')||'';if(h.indexOf(m)<0)continue;var isDemo=h.indexOf('src'+String.fromCharCode(37)+'3Ddemo')>=0||h.indexOf('src=demo')>=0;a[d]=1;st(a,isDemo)}}fix();if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',fix)}else{fix();var o=null;try{o=new MutationObserver(function(){fix()})}catch(e){}if(o){o.observe(document.documentElement,{childList:true,subtree:true});setTimeout(function(){try{o.disconnect()}catch(e){}},5000)}}}catch(e){}})();",
          }}
        />
        {/* Verified-visit beacon (admin rework 2b): the head beacon above fires
            BEFORE the page's JS runs, so it can't distinguish a real browser
            from a bot that merely fetched the HTML. This one only fires AFTER
            the page actually renders client-side (load → rAF → a tick) — a bot
            that doesn't execute JS never round-trips it. It POSTs
            {visitor_id, page, verified:true} to /api/track, which marks the
            matching page_visits row verified=1. Same skip guards as the head
            beacon (cc_skip + utility pages). */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var p=location.pathname;if(localStorage.getItem('cc_skip')==='1')return;if(p==='/support'||p==='/privacy'||p==='/terms'||p==='/admin'||p.indexOf('/support/')===0||p.indexOf('/privacy/')===0||p.indexOf('/terms/')===0||p.indexOf('/admin/')===0)return;var v=localStorage.getItem('cc_vid');if(!v)return;function fire(){try{var b=new Blob([JSON.stringify({visitor_id:v,page:p,verified:true})],{type:'application/json'});if(navigator.sendBeacon){navigator.sendBeacon('/api/track',b)}else{var x=new XMLHttpRequest();x.open('POST','/api/track',true);x.send(b)}}catch(e){}}var done=false;function go(){if(done)return;done=true;if(typeof requestAnimationFrame==='function'){requestAnimationFrame(function(){setTimeout(fire,50)})}else{setTimeout(fire,100)}}if(document.readyState==='complete'){setTimeout(go,0)}else{window.addEventListener('load',function(){setTimeout(go,0)})}}catch(e){}})();",
          }}
        />
        {/* Microsoft Clarity analytics (owner 2026-09-02). Script body is
            verbatim from the owner; encoded as a string because raw JSX
            breaks on the braces. Renders as the exact snippet. */}
        <script
          type="text/javascript"
          dangerouslySetInnerHTML={{
            __html: `(function(c,l,a,r,i,t,y){
              c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
              t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
              y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
            })(window, document, "clarity", "script", "yc6gd7x9vk");`,
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

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
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

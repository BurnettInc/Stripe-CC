import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  server: {
    port: 3000,
    host: true,
    // The site is reverse-proxied behind <label>.<PUBLIC_SITE_DOMAIN>; the proxy
    // masks the Host to localhost:3000, but accept any host so a dev server never
    // rejects a proxied request with "Blocked request".
    allowedHosts: true,
    // Mirror serve.ts: forward /api/* and /app/* (the Stripe App backend surface)
    // to the backend on port 3002, stripping the prefix so the backend sees its
    // own paths (e.g. /api/health -> /health, /app/oauth/callback -> /oauth/callback).
    // Keeps dev behaviour identical to the published server so the Stripe App is
    // testable through the dev site while the backend stays on 3002.
    proxy: {
      "^/(api|app)(/|$)": {
        target: "http://localhost:3002",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/(api|app)/, "") || "/",
      },
    },
  },
  plugins: [
    tailwindcss(),
    tsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
    tanstackStart(),
    viteReact(),
  ],
});

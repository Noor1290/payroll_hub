import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { buildCsp } from "./src/config/csp.ts";

const DEFAULT_BASE = "/payroll-hub/";

function normaliseBase(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BASE;
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

/**
 * Adds the Content Security Policy <meta> tag to the production index.html.
 * Not used by the dev server, whose hot reloading needs inline scripts and a websocket.
 */
function contentSecurityPolicy(supabaseUrl: string | undefined): Plugin {
  return {
    name: "payroll-hub:csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: buildCsp({ supabaseUrl }) },
        injectTo: "head-prepend",
      },
    ],
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const { version } = JSON.parse(
    readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
  ) as { version: string };

  // `npm run dev:demo` turns demo mode on without touching .env.
  // Only the dev server can do this; a production build never sees the flag.
  if (command === "serve" && mode === "demo") {
    process.env.VITE_DEMO_MODE = "true";
  }

  return {
    base: normaliseBase(env.VITE_BASE_PATH),
    plugins: [
      react(),
      tailwindcss(),
      // VITE_DISABLE_CSP=true leaves the policy out, in case it ever blocks something it shouldn't.
      ...(env.VITE_DISABLE_CSP === "true" ? [] : [contentSecurityPolicy(env.VITE_SUPABASE_URL)]),
    ],
    define: { __APP_VERSION__: JSON.stringify(version) },
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    build: { sourcemap: false },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
    },
  };
});

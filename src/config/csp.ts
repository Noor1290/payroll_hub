import { HOSTING } from "./origins.ts";

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * The Content Security Policy the production build ships as a <meta> tag.
 *
 * It limits what the page may load and talk to: its own files, the Supabase project, and the
 * registered apps in iframes. It does not isolate the dashboard from those apps (they share an
 * origin; see the README), and GitHub Pages cannot send the headers that would stop other
 * sites from framing the dashboard.
 *
 * Kept free of browser and Vite APIs so both the build (vite.config.ts) and the tests can use it.
 */
export function buildCsp(options: {
  supabaseUrl?: string;
  appOrigins?: readonly string[];
}): string {
  const supabaseOrigin = originOf(options.supabaseUrl);
  const frames = [...new Set(options.appOrigins ?? [HOSTING.apps])];

  const policy: Record<string, string[]> = {
    "default-src": ["'self'"],
    // Only the dashboard's own bundled scripts. No inline scripts, no eval, no CDNs.
    "script-src": ["'self'"],
    // Inline style attributes are needed for animations and positioned menus.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    // The only server the dashboard talks to.
    "connect-src": ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])],
    // The registered apps, and nothing else, may be embedded.
    "frame-src": frames,
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };

  return Object.entries(policy)
    .map(([directive, values]) => `${directive} ${values.join(" ")}`)
    .join("; ");
}

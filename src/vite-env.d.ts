/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_IDLE_TIMEOUT_MINUTES?: string;
  readonly VITE_BASE_PATH?: string;
  readonly VITE_DEMO_MODE?: string;
  /** Set by the deploy workflow; shown in Settings > About. */
  readonly VITE_COMMIT_SHA?: string;
  /** "true" leaves the Content Security Policy tag out of the build. */
  readonly VITE_DISABLE_CSP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The version in package.json, set at build time. */
declare const __APP_VERSION__: string;

declare module "@fontsource-variable/geist";
declare module "@fontsource-variable/geist-mono";

import type { StatusTone } from "@/components/ui/misc";
import { isOffDeployedOrigin } from "@/config/apps.config";
import type { AppHealth } from "@/lib/bridge/hub";

export interface HealthView {
  tone: StatusTone;
  /** Short status, shown next to the dot. */
  label: string;
  /** One sentence on what it means and what to do. */
  detail: string;
}

const VIEWS: Record<AppHealth, HealthView> = {
  "coming-soon": {
    tone: "idle",
    label: "Coming soon",
    detail: "This app hasn't been built yet.",
  },
  idle: {
    tone: "idle",
    label: "Not opened",
    detail: "The app hasn't been loaded in this session.",
  },
  loading: { tone: "pending", label: "Loading", detail: "Waiting for the app to load and answer." },
  ready: { tone: "ready", label: "Ready", detail: "Connected. Data can be sent to this app." },
  "no-bridge": {
    tone: "detached",
    label: "Bridge not installed",
    detail:
      "The page loaded, but it didn't answer the dashboard. The app works on its own here; to exchange data it needs bridge.js (see docs/INTEGRATION.md).",
  },
  unresponsive: {
    tone: "error",
    label: "Not responding",
    detail: "The app was connected and has stopped answering. Reload it to reconnect.",
  },
  failed: {
    tone: "error",
    label: "Failed to load",
    detail: "The app didn't finish loading. Check that its site is up, then reload it.",
  },
};

export function healthView(health: AppHealth | undefined): HealthView {
  const view = VIEWS[health ?? "idle"];
  if (health === "no-bridge" && isOffDeployedOrigin()) {
    return {
      ...view,
      label: "Not connected (local run)",
      detail:
        "The live apps only talk to the deployed dashboard, so on this address they can be used but not connected. Use the deployed site, or `npm run dev:demo` for mock apps.",
    };
  }
  return view;
}

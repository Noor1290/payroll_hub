import { useEffect, useRef, useState } from "react";
import { Columns2, ExternalLink, Maximize2, RotateCw, TriangleAlert, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { Badge, StatusDot } from "@/components/ui/misc";
import { EmptyState } from "@/components/ui/states";
import { Tooltip } from "@/components/ui/tooltip";
import { APPS, appUrl, type AppConfig } from "@/config/apps.config";
import { bridge, useAppHealth } from "@/lib/bridge/bridge";
import type { AppHealth } from "@/lib/bridge/hub";
import { cn } from "@/lib/utils";
import { healthView } from "./health";

/** Exactly the permissions the apps need. With a shared origin this is NOT a security boundary. */
const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-downloads allow-modals allow-popups";

const ACTIVE_APPS = APPS.filter((app) => app.status === "active" && app.url);

function AppPane({ app, health, shown }: { app: AppConfig; health: AppHealth; shown: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState<AppHealth | null>(null);
  const view = healthView(health);
  const url = appUrl(app);

  useEffect(() => {
    bridge.attachFrame(app.id, () => frame.current?.contentWindow ?? null);
    return () => bridge.detachFrame(app.id);
  }, [app.id]);

  const reload = () => {
    const element = frame.current;
    if (!element) return;
    setDismissed(null);
    bridge.attachFrame(app.id, () => frame.current?.contentWindow ?? null);
    element.src = url;
  };

  const showBanner = (health === "no-bridge" || health === "unresponsive") && dismissed !== health;

  return (
    <div
      ref={pane}
      role="tabpanel"
      id={`workspace-panel-${app.id}`}
      aria-labelledby={`workspace-tab-${app.id}`}
      // Hidden panes stay mounted so the app inside keeps its state.
      className={cn("min-h-0 min-w-0 flex-col bg-canvas", shown ? "flex" : "hidden")}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <app.icon
          className="size-4 shrink-0"
          style={{ color: app.accentColor }}
          aria-hidden="true"
        />
        <span className="truncate text-sm font-medium">{app.name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted" aria-live="polite">
          <StatusDot tone={view.tone} />
          {view.label}
        </span>
        <div className="ml-auto flex items-center">
          <Tooltip label="Reload this app">
            <Button size="icon" variant="ghost" aria-label={`Reload ${app.name}`} onClick={reload}>
              <RotateCw aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip label="Full screen">
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Show ${app.name} full screen`}
              onClick={() => void pane.current?.requestFullscreen?.().catch(() => {})}
            >
              <Maximize2 aria-hidden="true" />
            </Button>
          </Tooltip>
          <Tooltip label="Open in a new tab (standalone)">
            <Button asChild size="icon" variant="ghost">
              <a
                href={app.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${app.name} in a new tab`}
              >
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          </Tooltip>
        </div>
      </div>

      {showBanner && (
        <div
          role="status"
          className="flex shrink-0 items-start gap-3 border-b border-line bg-surface px-4 py-2.5 text-sm"
        >
          <TriangleAlert
            className={cn(
              "mt-0.5 size-4 shrink-0",
              health === "no-bridge" ? "text-glow" : "text-danger",
            )}
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 text-muted">
            <span className="font-medium text-fg">{view.label}.</span> {view.detail}
          </p>
          <button
            type="button"
            aria-label="Dismiss this notice"
            onClick={() => setDismissed(health)}
            className="rounded p-0.5 text-subtle hover:text-fg"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-white">
        <iframe
          ref={frame}
          src={url}
          title={app.name}
          sandbox={SANDBOX}
          referrerPolicy="no-referrer"
          onLoad={() => bridge.frameLoaded(app.id)}
          className="size-full border-0"
        />
        {health === "failed" && (
          <div className="absolute inset-0 grid place-items-center bg-canvas p-6">
            <div role="alert" className="glass max-w-md rounded-2xl p-8 text-center">
              <span className="mx-auto grid size-11 place-items-center rounded-full border border-danger/30 bg-danger/10">
                <TriangleAlert className="size-5 text-danger" aria-hidden="true" />
              </span>
              <h2 className="mt-4 font-semibold">{app.name} didn't load</h2>
              <p className="mt-1.5 text-sm text-muted">
                {view.detail} The dashboard and the other apps are not affected.
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Button onClick={reload}>
                  <RotateCw aria-hidden="true" />
                  Try again
                </Button>
                <Button asChild variant="ghost">
                  <a href={app.url} target="_blank" rel="noopener noreferrer">
                    <ExternalLink aria-hidden="true" />
                    Open in a new tab
                  </a>
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Hosts every active app in an iframe. It lives in the app shell, not in a route, and is only
 * hidden with CSS when another page is showing: the apps stay loaded, keep their state, keep
 * reporting health, and can receive data from any screen.
 */
export function WorkspaceHost({ visible }: { visible: boolean }) {
  const health = useAppHealth();
  const [params, setParams] = useSearchParams();
  const [split, setSplit] = useState(false);
  const [lastActive, setLastActive] = useState(ACTIVE_APPS[0]?.id ?? "");

  useEffect(() => {
    bridge.start();
    return () => bridge.stop();
  }, []);

  const requested = visible ? params.get("app") : null;
  const activeId = ACTIVE_APPS.some((app) => app.id === requested) ? requested! : lastActive;
  if (activeId !== lastActive) setLastActive(activeId);

  const secondId = split ? ACTIVE_APPS.find((app) => app.id !== activeId)?.id : undefined;
  const select = (id: string) => setParams({ app: id }, { replace: true });

  return (
    <div
      className={cn("absolute inset-0 z-[5] flex-col bg-canvas", visible ? "flex" : "hidden")}
      aria-hidden={!visible}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <h1 className="sr-only">Workspace</h1>
        <div role="tablist" aria-label="Apps" className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {APPS.map((app) => {
            const usable = ACTIVE_APPS.includes(app);
            const selected = app.id === activeId;
            const view = healthView(health[app.id]);
            return (
              <Tooltip key={app.id} label={`${app.name}: ${view.label}. ${view.detail}`}>
                <button
                  type="button"
                  role="tab"
                  id={`workspace-tab-${app.id}`}
                  aria-selected={selected}
                  aria-controls={`workspace-panel-${app.id}`}
                  aria-disabled={!usable}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => usable && select(app.id)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                    const index = ACTIVE_APPS.findIndex((a) => a.id === activeId);
                    const step = event.key === "ArrowRight" ? 1 : ACTIVE_APPS.length - 1;
                    const next = ACTIVE_APPS[(index + step) % ACTIVE_APPS.length];
                    if (next) {
                      select(next.id);
                      document.getElementById(`workspace-tab-${next.id}`)?.focus();
                    }
                  }}
                  className={cn(
                    "flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors",
                    selected
                      ? "bg-accent/10 text-fg shadow-inner-glow"
                      : "text-muted hover:bg-surface-hover hover:text-fg",
                    !usable &&
                      "cursor-not-allowed opacity-60 hover:bg-transparent hover:text-muted",
                  )}
                >
                  <StatusDot tone={view.tone} />
                  {app.name}
                  {!usable && <Badge>Soon</Badge>}
                </button>
              </Tooltip>
            );
          })}
        </div>
        {ACTIVE_APPS.length > 1 && (
          <Button
            size="sm"
            aria-pressed={split}
            onClick={() => setSplit((value) => !value)}
            className="hidden md:inline-flex"
          >
            <Columns2 aria-hidden="true" />
            {split ? "Single view" : "Split view"}
          </Button>
        )}
      </div>

      {ACTIVE_APPS.length === 0 ? (
        <EmptyState title="No apps to show yet" className="py-20">
          Add an app to src/config/apps.config.ts and it will appear here as a tab.
        </EmptyState>
      ) : (
        <div
          className={cn("grid min-h-0 flex-1", secondId ? "grid-cols-2 divide-x divide-line" : "")}
        >
          {ACTIVE_APPS.map((app) => (
            // One app throwing while rendering its pane must not take the others down.
            <ErrorBoundary key={app.id}>
              <AppPane
                app={app}
                health={health[app.id] ?? "idle"}
                shown={app.id === activeId || app.id === secondId}
              />
            </ErrorBoundary>
          ))}
        </div>
      )}
    </div>
  );
}

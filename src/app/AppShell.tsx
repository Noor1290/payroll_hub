import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useLocation, useOutlet } from "react-router-dom";
import { AuroraBackground } from "@/components/brand";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { BridgeDialogs } from "@/features/workspace/BridgeDialogs";
import { WorkspaceHost } from "@/features/workspace/WorkspaceHost";
import { preferenceStorage } from "@/lib/storage";
import { CommandPalette } from "./CommandPalette";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * Renders the route that was current when this instance mounted, and keeps rendering it.
 * A plain <Outlet /> inside the page-transition wrapper would switch to the NEW route while
 * the old page is still animating out, mounting every page twice per navigation.
 */
function FrozenOutlet() {
  const outlet = useOutlet();
  const [frozen] = useState(outlet);
  return frozen;
}

const SIDEBAR_KEY = "sidebar-collapsed";

export function AppShell() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => preferenceStorage.getItem(SIDEBAR_KEY) === "1");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      preferenceStorage.setItem(SIDEBAR_KEY, current ? "0" : "1");
      return !current;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="relative flex h-full">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        onClick={(event) => {
          // HashRouter owns the URL hash, so move focus by hand instead of navigating.
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      <AuroraBackground />
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        mobileOpen={mobileNavOpen}
        onMobileOpenChange={setMobileNavOpen}
      />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <TopBar
          onOpenMobileNav={() => setMobileNavOpen(true)}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        <main id="main-content" tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
          {/* Always mounted, shown only on the Workspace route, so the apps keep running. */}
          <WorkspaceHost visible={location.pathname === "/workspace"} />
          <div className="h-full overflow-y-auto">
            <ErrorBoundary resetKey={location.pathname}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                  className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8"
                >
                  <FrozenOutlet />
                </motion.div>
              </AnimatePresence>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <BridgeDialogs />
    </div>
  );
}

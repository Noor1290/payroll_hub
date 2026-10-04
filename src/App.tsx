import { lazy, Suspense, type ComponentType, type CSSProperties } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { HashRouter, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { AppShell } from "@/app/AppShell";
import { NAV_ITEMS } from "@/app/nav";
import { NotFoundPage } from "@/app/pages";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Skeleton } from "@/components/ui/misc";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/features/auth/AuthProvider";
import { LoginPage } from "@/features/auth/LoginPage";
import { RequireAuth } from "@/features/auth/RequireAuth";
import { CompanyProvider } from "@/features/company/CompanyProvider";
import { OverviewPage } from "@/features/overview/OverviewPage";
import { useTheme } from "@/features/theme/theme-context";
import { ThemeProvider } from "@/features/theme/ThemeProvider";
import { queryClient } from "@/lib/queryClient";

/**
 * One screen per navigation item. Sign-in and the Overview load with the app; every other
 * screen is fetched the first time it is opened, which keeps the first load small.
 */
const SCREENS: Record<string, ComponentType> = {
  "/import": lazy(() =>
    import("@/features/import/ImportPage").then((m) => ({ default: m.ImportPage })),
  ),
  "/explorer": lazy(() =>
    import("@/features/explorer/ExplorerPage").then((m) => ({ default: m.ExplorerPage })),
  ),
  "/transfer": lazy(() =>
    import("@/features/transfer/TransferPage").then((m) => ({ default: m.TransferPage })),
  ),
  "/log": lazy(() =>
    import("@/features/transfer/TransferLogPage").then((m) => ({ default: m.TransferLogPage })),
  ),
  "/links": lazy(() =>
    import("@/features/links/LinksPage").then((m) => ({ default: m.LinksPage })),
  ),
  "/profile": lazy(() =>
    import("@/features/profile/ProfilePage").then((m) => ({ default: m.ProfilePage })),
  ),
  "/history": lazy(() =>
    import("@/features/history/HistoryPage").then((m) => ({ default: m.HistoryPage })),
  ),
  "/database": lazy(() =>
    import("@/features/database/DatabasePage").then((m) => ({ default: m.DatabasePage })),
  ),
  "/settings": lazy(() =>
    import("@/features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })),
  ),
  // The Workspace is rendered by the shell (WorkspaceHost) so the apps survive navigation.
  "/workspace": () => null,
};

function ScreenLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="space-y-4">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-5 w-96 max-w-full" />
      <Skeleton className="mt-6 h-72 rounded-2xl" />
    </div>
  );
}

function Screen({ path }: { path: string }) {
  const Component = SCREENS[path] ?? NotFoundPage;
  return (
    <Suspense fallback={<ScreenLoading />}>
      <Component />
    </Suspense>
  );
}

function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      theme={resolved}
      position="bottom-right"
      // Modal dialogs turn off pointer events for the rest of the page. Toasts must stay
      // clickable above them: a failed delivery offers Retry while a dialog is still open.
      // Wider than the default so a failure message and its two actions fit side by side.
      style={{ pointerEvents: "auto", "--width": "30rem" } as CSSProperties}
      toastOptions={{
        style: {
          background: "var(--elevated)",
          border: "1px solid var(--line)",
          color: "var(--fg)",
        },
      }}
    />
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        {/* reducedMotion="user" turns transforms off for people who ask the OS for less motion. */}
        <MotionConfig reducedMotion="user">
          <TooltipProvider delayDuration={250}>
            <QueryClientProvider client={queryClient}>
              <AuthProvider>
                <HashRouter>
                  <Routes>
                    <Route path="/login" element={<LoginPage />} />
                    <Route
                      element={
                        <RequireAuth>
                          <CompanyProvider>
                            <AppShell />
                          </CompanyProvider>
                        </RequireAuth>
                      }
                    >
                      <Route index element={<OverviewPage />} />
                      {NAV_ITEMS.filter((item) => item.to !== "/").map((item) => (
                        <Route key={item.to} path={item.to} element={<Screen path={item.to} />} />
                      ))}
                      <Route path="*" element={<NotFoundPage />} />
                    </Route>
                  </Routes>
                </HashRouter>
              </AuthProvider>
            </QueryClientProvider>
          </TooltipProvider>
        </MotionConfig>
        <ThemedToaster />
      </ThemeProvider>
    </ErrorBoundary>
  );
}

import * as Dialog from "@radix-ui/react-dialog";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { NavLink } from "react-router-dom";
import { LogoMark } from "@/components/brand";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useCompany } from "@/features/company/company-context";
import { navItemsFor } from "./nav";

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { isAdmin } = useCompany();
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-2">
      <ul className="space-y-1">
        {navItemsFor(isAdmin).map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Tooltip label={label} side="right" disabled={!collapsed}>
              <NavLink
                to={to}
                end={to === "/"}
                onClick={onNavigate}
                aria-label={collapsed ? label : undefined}
                className={({ isActive }) =>
                  cn(
                    "group relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
                    collapsed && "justify-center px-0",
                    isActive
                      ? "bg-accent/10 text-fg shadow-inner-glow"
                      : "text-muted hover:bg-surface-hover hover:text-fg",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-accent transition-opacity",
                        isActive ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <Icon
                      className={cn("size-[18px] shrink-0", isActive && "text-accent")}
                      aria-hidden="true"
                    />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </>
                )}
              </NavLink>
            </Tooltip>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn("flex h-16 shrink-0 items-center gap-3 px-4", collapsed && "justify-center")}
    >
      <LogoMark />
      {!collapsed && <span className="font-semibold tracking-tight">Payroll Hub</span>}
    </div>
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onMobileOpenChange,
}: SidebarProps) {
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar";

  return (
    <>
      {/* Desktop: fixed column that collapses to icons. */}
      <aside
        className={cn(
          "relative z-10 hidden shrink-0 flex-col border-r border-line bg-canvas/60 backdrop-blur-xl transition-[width] duration-200 ease-out lg:flex",
          collapsed ? "w-[72px]" : "w-62",
        )}
      >
        <Brand collapsed={collapsed} />
        <NavList collapsed={collapsed} />
        <div className="border-t border-line p-3">
          <Tooltip label={toggleLabel} side="right" disabled={!collapsed}>
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={toggleLabel}
              aria-expanded={!collapsed}
              className={cn(
                "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-fg",
                collapsed && "justify-center px-0",
              )}
            >
              <ToggleIcon className="size-[18px] shrink-0" aria-hidden="true" />
              {!collapsed && <span>Collapse</span>}
            </button>
          </Tooltip>
        </div>
      </aside>

      {/* Tablet and phone: the same navigation as a drawer. */}
      <Dialog.Root open={mobileOpen} onOpenChange={onMobileOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-elevated shadow-pop outline-none lg:hidden"
          >
            <Dialog.Title className="sr-only">Navigation</Dialog.Title>
            <div className="flex items-center justify-between pr-3">
              <Brand collapsed={false} />
              <Dialog.Close
                aria-label="Close navigation"
                className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-hover hover:text-fg"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>
            <NavList collapsed={false} onNavigate={() => onMobileOpenChange(false)} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

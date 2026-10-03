import { LogOut, Menu, Monitor, Moon, Search, Sun } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge, Kbd, StatusDot } from "@/components/ui/misc";
import { Tooltip } from "@/components/ui/tooltip";
import { useAuth } from "@/features/auth/auth-context";
import { CompanySwitcher } from "@/features/company/CompanySwitcher";
import { useTheme } from "@/features/theme/theme-context";
import { healthView } from "@/features/workspace/health";
import { APPS } from "@/config/apps.config";
import { useAppHealth } from "@/lib/bridge/bridge";
import { PALETTE_SHORTCUT } from "./nav";

function initials(email: string): string {
  const name = email.split("@")[0] ?? "";
  const parts = name.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : name.slice(0, 2);
  return letters.toUpperCase() || "?";
}

interface TopBarProps {
  onOpenMobileNav: () => void;
  onOpenPalette: () => void;
}

export function TopBar({ onOpenMobileNav, onOpenPalette }: TopBarProps) {
  const { user, signOut } = useAuth();
  const { theme, resolved, setTheme, toggle } = useTheme();
  const health = useAppHealth();
  const ThemeIcon = resolved === "dark" ? Moon : Sun;

  return (
    <header className="relative z-10 flex h-16 shrink-0 items-center gap-2 border-b border-line bg-canvas/60 px-3 backdrop-blur-xl sm:gap-3 sm:px-5">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        aria-label="Open navigation"
        onClick={onOpenMobileNav}
      >
        <Menu aria-hidden="true" />
      </Button>

      <CompanySwitcher />

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label={`Search and commands (${PALETTE_SHORTCUT})`}
        className="ml-auto flex h-10 items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-sm text-subtle shadow-inner-glow transition-colors hover:border-line-strong hover:text-fg md:w-64"
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="hidden flex-1 text-left md:inline">Search or jump to…</span>
        <Kbd className="hidden md:inline-flex">{PALETTE_SHORTCUT}</Kbd>
      </button>

      {/* Live connection status of each registered app. Click to open it in the Workspace. */}
      <ul aria-label="App status" className="hidden items-center gap-1 xl:flex">
        {APPS.map((app) => {
          const view = healthView(health[app.id]);
          return (
            <li key={app.id}>
              <Tooltip label={`${app.name}: ${view.label}`}>
                <Link
                  to={app.status === "active" ? `/workspace?app=${app.id}` : "/workspace"}
                  aria-label={`${app.name}: ${view.label}. Open in the Workspace`}
                  className="grid size-8 place-items-center rounded-lg hover:bg-surface-hover"
                >
                  <StatusDot tone={view.tone} />
                </Link>
              </Tooltip>
            </li>
          );
        })}
      </ul>

      <Tooltip label={`Switch to ${resolved === "dark" ? "light" : "dark"} theme`}>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} theme`}
        >
          <ThemeIcon aria-hidden="true" />
        </Button>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className="grid size-9 shrink-0 place-items-center rounded-full border border-accent/40 bg-accent/10 text-xs font-semibold text-accent"
          >
            {initials(user?.email ?? "")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <div className="px-2.5 py-2">
            <p className="truncate text-sm font-medium text-fg">{user?.email}</p>
            {user?.isDemo && (
              <Badge tone="warn" className="mt-1.5">
                Demo session
              </Badge>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          {(
            [
              ["system", "Match system", Monitor],
              ["dark", "Dark", Moon],
              ["light", "Light", Sun],
            ] as const
          ).map(([value, label, Icon]) => (
            <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
              <Icon aria-hidden="true" />
              <span className="flex-1">{label}</span>
              {theme === value && <span className="text-xs text-accent">Current</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void signOut()}>
            <LogOut aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

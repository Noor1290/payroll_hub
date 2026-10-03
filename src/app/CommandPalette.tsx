import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import {
  ArrowLeftRight,
  Building2,
  Lock,
  LogOut,
  Monitor,
  Moon,
  Search,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Kbd } from "@/components/ui/misc";
import { useAuth } from "@/features/auth/auth-context";
import { useCompany } from "@/features/company/company-context";
import { useTheme, type ThemeChoice } from "@/features/theme/theme-context";
import { healthView } from "@/features/workspace/health";
import { APPS } from "@/config/apps.config";
import { useAppHealth } from "@/lib/bridge/bridge";
import { navItemsFor } from "./nav";

const GROUP_CLASS =
  "px-2 py-1.5 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-subtle";

const ITEM_CLASS =
  "flex cursor-default items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm text-muted select-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-hover data-[selected=true]:text-fg";

function Item({
  icon: Icon,
  children,
  hint,
  ...props
}: {
  icon: LucideIcon;
  children: ReactNode;
  hint?: string;
  value: string;
  keywords?: string[];
  disabled?: boolean;
  onSelect?: () => void;
}) {
  return (
    <Command.Item className={ITEM_CLASS} {...props}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-xs text-subtle">{hint}</span>}
    </Command.Item>
  );
}

const THEMES: readonly [ThemeChoice, string, LucideIcon][] = [
  ["dark", "Dark theme", Moon],
  ["light", "Light theme", Sun],
  ["system", "Match system theme", Monitor],
];

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const { memberships, current, select, isAdmin } = useCompany();
  const health = useAppHealth();

  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[14vh] left-1/2 z-50 w-[min(92vw,40rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-line-strong bg-elevated shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command label="Command palette" loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-4 shrink-0 text-subtle" aria-hidden="true" />
              <Command.Input
                placeholder="Type a command or search…"
                className="h-14 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-subtle"
              />
              <Kbd>Esc</Kbd>
            </div>
            <Command.List className="max-h-[min(60vh,26rem)] overflow-y-auto py-1.5">
              <Command.Empty className="px-4 py-10 text-center text-sm text-muted">
                Nothing matches. Try a page name like “Import”.
              </Command.Empty>

              <Command.Group heading="Go to" className={GROUP_CLASS}>
                {navItemsFor(isAdmin).map(({ to, label, icon, description }) => (
                  <Item
                    key={to}
                    value={`go ${label}`}
                    keywords={[description]}
                    icon={icon}
                    onSelect={() => run(() => navigate(to))}
                  >
                    {label}
                  </Item>
                ))}
              </Command.Group>

              {memberships.length > 1 && (
                <Command.Group heading="Switch company" className={GROUP_CLASS}>
                  {memberships.map(({ company, role }) => (
                    <Item
                      key={company.id}
                      value={`company ${company.name} ${company.id}`}
                      keywords={["switch", company.brn ?? ""]}
                      icon={Building2}
                      hint={company.id === current?.company.id ? `Current · ${role}` : role}
                      onSelect={() => run(() => select(company.id))}
                    >
                      {company.name}
                    </Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Open an app" className={GROUP_CLASS}>
                {APPS.map((app) => {
                  const view = healthView(health[app.id]);
                  return (
                    <Item
                      key={app.id}
                      value={`open app ${app.name}`}
                      keywords={["workspace", app.id]}
                      icon={app.icon}
                      hint={view.label}
                      disabled={app.status !== "active"}
                      onSelect={() => run(() => navigate(`/workspace?app=${app.id}`))}
                    >
                      {app.name}
                    </Item>
                  );
                })}
              </Command.Group>

              <Command.Group heading="Actions" className={GROUP_CLASS}>
                <Item
                  value="start a transfer"
                  keywords={["send", "wizard", "map"]}
                  icon={ArrowLeftRight}
                  onSelect={() => run(() => navigate("/transfer"))}
                >
                  Start a transfer
                </Item>
                {isAdmin && (
                  <Item
                    value="open database"
                    keywords={["tables", "raw", "rows", "sql"]}
                    icon={Lock}
                    onSelect={() => run(() => navigate("/database"))}
                  >
                    Open Database
                  </Item>
                )}
              </Command.Group>

              <Command.Group heading="Preferences" className={GROUP_CLASS}>
                {THEMES.map(([value, label, icon]) => (
                  <Item
                    key={value}
                    value={label}
                    keywords={["theme", "appearance"]}
                    icon={icon}
                    hint={theme === value ? "Current" : undefined}
                    onSelect={() => run(() => setTheme(value))}
                  >
                    {label}
                  </Item>
                ))}
              </Command.Group>

              <Command.Group heading="Account" className={GROUP_CLASS}>
                <Item
                  value="sign out"
                  keywords={["log out", "logout"]}
                  icon={LogOut}
                  onSelect={() => run(() => void signOut())}
                >
                  Sign out
                </Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

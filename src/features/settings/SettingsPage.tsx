import { useId, useState, type ReactNode } from "react";
import {
  AppWindow,
  Eraser,
  Info,
  LockKeyhole,
  Monitor,
  Moon,
  Palette,
  RotateCw,
  Shuffle,
  Sun,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge, StatusDot } from "@/components/ui/misc";
import { APPS, getApp, PROTOCOL_VERSION } from "@/config/apps.config";
import { useTheme, type ThemeChoice } from "@/features/theme/theme-context";
import { deleteTemplate, mappingTemplates } from "@/features/transfer/templates";
import { healthView } from "@/features/workspace/health";
import { useAppHealth } from "@/lib/bridge/bridge";
import { formatCount, formatDateTime } from "@/lib/format";
import {
  clampIdleMinutes,
  clampRefreshSeconds,
  clampUnlockMinutes,
  IDLE_MINUTES,
  IDLE_SIGN_OUT_ENABLED,
  idleMinutes,
  REFRESH_SECONDS,
  refreshSeconds,
  setIdleMinutes,
  setRefreshSeconds,
  setUnlockMinutes,
  UNLOCK_MINUTES,
  unlockMinutes,
} from "@/lib/preferences";
import { clearInMemoryData } from "@/lib/sessionCleanup";
import { useStore, type Store } from "@/lib/store";
import { cn } from "@/lib/utils";

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="glass rounded-2xl">
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <Icon className="size-4 text-accent" aria-hidden="true" />
        <h2 id={headingId} className="font-semibold">
          {title}
        </h2>
      </div>
      <div className="space-y-5 p-5">{children}</div>
    </section>
  );
}

/** A whole-number preference with a fixed range. Saves as you type; snaps back to a valid value on blur. */
function NumberSetting({
  label,
  unit,
  range,
  store,
  save,
  clamp,
  help,
}: {
  label: string;
  unit: string;
  range: { min: number; max: number };
  store: Store<number>;
  save: (value: number) => number;
  clamp: (value: unknown) => number;
  help: string;
}) {
  const saved = useStore(store);
  const [text, setText] = useState(String(saved));
  const inputId = useId();
  const helpId = useId();
  const inRange = (value: string) => {
    const number = Number(value);
    return (
      value.trim() !== "" && Number.isInteger(number) && number >= range.min && number <= range.max
    );
  };
  const valid = inRange(text);

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex items-center gap-3">
        <Input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={range.min}
          max={range.max}
          step={1}
          value={text}
          aria-invalid={!valid}
          aria-describedby={helpId}
          onChange={(event) => {
            setText(event.target.value);
            if (inRange(event.target.value)) save(Number(event.target.value));
          }}
          onBlur={() => setText(String(save(clamp(text))))}
          className="tabular w-24"
        />
        <span className="text-sm text-muted">{unit}</span>
      </div>
      <p id={helpId} className={cn("text-sm", valid ? "text-muted" : "text-danger")}>
        {valid
          ? `Between ${range.min} and ${range.max}. ${help}`
          : `Enter a whole number from ${range.min} to ${range.max}.`}
      </p>
    </div>
  );
}

const THEMES: readonly [ThemeChoice, string, LucideIcon][] = [
  ["system", "Match system", Monitor],
  ["dark", "Dark", Moon],
  ["light", "Light", Sun],
];

function ThemeSetting() {
  const { theme, setTheme } = useTheme();
  return (
    <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-2">
      {THEMES.map(([value, label, Icon]) => {
        const selected = theme === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(value)}
            className={cn(
              "flex h-10 items-center gap-2 rounded-lg border px-4 text-sm font-medium transition-colors",
              selected
                ? "border-accent bg-accent/10 text-fg"
                : "border-line bg-surface text-muted hover:border-line-strong hover:text-fg",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}

function TemplatesSetting() {
  const templates = useStore(mappingTemplates);
  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted">
        None saved yet. Save one from the Mapping step of a transfer and it will be listed here.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-line rounded-xl border border-line">
      {templates.map((template) => (
        <li key={template.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{template.name}</p>
            <p className="text-xs text-muted">
              For {getApp(template.destinationId)?.name ?? template.destinationId},{" "}
              {formatCount(Object.keys(template.mapping).length)} fields, saved{" "}
              {formatDateTime(template.savedAt)}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete the mapping "${template.name}"`}
            onClick={() => deleteTemplate(template.id)}
          >
            <Trash2 aria-hidden="true" />
            Delete
          </Button>
        </li>
      ))}
    </ul>
  );
}

function RegistryViewer() {
  const health = useAppHealth();
  return (
    <div
      className="overflow-auto rounded-xl border border-line"
      tabIndex={0}
      role="region"
      aria-label="Registered apps"
    >
      <table className="w-full border-separate border-spacing-0 text-sm">
        <caption className="sr-only">Registered apps (read only)</caption>
        <thead>
          <tr>
            {["App", "Status", "Receives", "Sends", "Fields", "Address"].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="border-b border-line bg-elevated px-4 py-2.5 text-left text-xs font-medium whitespace-nowrap text-muted"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {APPS.map((app) => {
            const view = healthView(health[app.id]);
            return (
              <tr key={app.id}>
                <th scope="row" className="border-b border-line px-4 py-2.5 text-left font-normal">
                  <span className="flex items-center gap-2 font-medium whitespace-nowrap">
                    <app.icon
                      className="size-4"
                      style={{ color: app.accentColor }}
                      aria-hidden="true"
                    />
                    {app.name}
                  </span>
                  <span className="tabular text-xs text-subtle">{app.id}</span>
                </th>
                <td className="border-b border-line px-4 py-2.5 whitespace-nowrap">
                  <span className="flex items-center gap-2 text-muted">
                    <StatusDot tone={view.tone} />
                    {view.label}
                  </span>
                </td>
                <td className="tabular border-b border-line px-4 py-2.5 text-muted">
                  {app.accepts.join(", ") || "nothing"}
                </td>
                <td className="tabular border-b border-line px-4 py-2.5 text-muted">
                  {app.produces.join(", ") || "nothing"}
                </td>
                <td className="tabular border-b border-line px-4 py-2.5 text-muted">
                  {formatCount(app.expectedFields.length)}
                </td>
                <td className="tabular border-b border-line px-4 py-2.5 text-xs whitespace-nowrap text-muted">
                  {app.url || "not built yet"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsPage() {
  const commit = import.meta.env.VITE_COMMIT_SHA?.slice(0, 7);

  return (
    <>
      <PageHeader title="Settings" description="Preferences are saved in this browser only." />

      <div className="mt-8 max-w-3xl space-y-6">
        <Section icon={Palette} title="Appearance">
          <ThemeSetting />
        </Section>

        <Section icon={LockKeyhole} title="Security">
          <p className="text-sm text-muted">
            The data explorer, the Database page, and sending saved runs to apps ask for your
            password first. After that they stay open for a fixed time and then lock again. They
            also lock when you sign out and when this tab has been in the background for more than
            two minutes.
          </p>
          <NumberSetting
            label="Keep sensitive areas unlocked for"
            unit="minutes"
            range={UNLOCK_MINUTES}
            store={unlockMinutes}
            save={setUnlockMinutes}
            clamp={clampUnlockMinutes}
            help="A change applies the next time you unlock."
          />
          {IDLE_SIGN_OUT_ENABLED ? (
            <NumberSetting
              label="Sign me out after no activity for"
              unit="minutes"
              range={IDLE_MINUTES}
              store={idleMinutes}
              save={setIdleMinutes}
              clamp={clampIdleMinutes}
              help="This signs you out completely, which also wipes everything held in memory."
            />
          ) : (
            <p className="text-sm text-muted">
              Automatic sign-out after inactivity was switched off when this site was built.
            </p>
          )}
          <p className="text-sm text-subtle">
            These are conveniences for shared or unattended screens. What each account can actually
            read or change is decided by the database's security rules.
          </p>
        </Section>

        <Section icon={RotateCw} title="Database page">
          <NumberSetting
            label="Refresh the Database page every"
            unit="seconds"
            range={REFRESH_SECONDS}
            store={refreshSeconds}
            save={setRefreshSeconds}
            clamp={clampRefreshSeconds}
            help="It pauses while the tab is in the background or the page is locked."
          />
        </Section>

        <Section icon={Shuffle} title="Saved mappings">
          <p className="text-sm text-muted">
            Column mappings saved in the transfer wizard. They hold column names only, never payroll
            values.
          </p>
          <TemplatesSetting />
        </Section>

        <Section icon={AppWindow} title="Apps">
          <p className="text-sm text-muted">
            The apps this dashboard knows about. The list is part of the dashboard's code
            (src/config/apps.config.ts) and can't be changed here.
          </p>
          <RegistryViewer />
        </Section>

        <Section icon={Eraser} title="Memory">
          <p className="text-sm text-muted">
            Wipes everything held in memory without signing you out: loaded payroll rows, data
            received from apps, failed transfers waiting to be retried, the transfer log, and the
            unlocked state. Nothing in the database is touched.
          </p>
          <Button
            onClick={() => {
              clearInMemoryData();
              toast.success("In-memory data cleared", {
                description: "Sensitive areas are locked again. Screens reload what they need.",
              });
            }}
          >
            <Eraser aria-hidden="true" />
            Clear all in-memory data
          </Button>
        </Section>

        <Section icon={Info} title="About">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted">Payroll Hub</dt>
            <dd className="tabular">
              {__APP_VERSION__}
              {commit && <Badge className="ml-2 normal-case">build {commit}</Badge>}
            </dd>
            <dt className="text-muted">Bridge protocol</dt>
            <dd className="tabular">version {PROTOCOL_VERSION}</dd>
            <dt className="text-muted">Data</dt>
            <dd>Supabase, with the public anon key and row-level security</dd>
          </dl>
        </Section>
      </div>
    </>
  );
}

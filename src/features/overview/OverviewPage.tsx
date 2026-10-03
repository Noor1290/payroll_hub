import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  AppWindow,
  ArrowLeftRight,
  ArrowUpRight,
  Banknote,
  CalendarDays,
  Layers,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router-dom";
import { AnimatedNumber } from "@/components/AnimatedNumber";
import { PageHeader } from "@/components/PageHeader";
import { Badge, Skeleton, StatusDot } from "@/components/ui/misc";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Tooltip } from "@/components/ui/tooltip";
import { APPS } from "@/config/apps.config";
import { useAuth } from "@/features/auth/auth-context";
import { StatusBadge } from "@/features/transfer/TransferLogPage";
import { transferLog } from "@/features/transfer/transferLog";
import { healthView } from "@/features/workspace/health";
import { useStore } from "@/lib/store";
import { useAppHealth } from "@/lib/bridge/bridge";
import { useCompany } from "@/features/company/company-context";
import { formatCount, formatDateTime, formatMoney, formatPeriod } from "@/lib/format";
import { classifyDataError } from "@/lib/supabase/errors";
import { fetchOverview, type Overview } from "@/lib/supabase/queries";
import type { RunSummary } from "@/lib/supabase/schemas";
import { cn } from "@/lib/utils";

const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

const rise = { hidden: { opacity: 0, y: 12 }, shown: { opacity: 1, y: 0 } };

function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.section variants={rise} className={cn("glass rounded-2xl", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
        <h2 className="font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </motion.section>
  );
}

function StatCard({
  icon: Icon,
  label,
  hint,
  children,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <motion.li
      variants={rise}
      className="glass rounded-2xl p-5 transition-transform duration-200 hover:-translate-y-0.5"
    >
      <div className="flex items-center gap-3 text-sm text-muted">
        <span className="grid size-9 place-items-center rounded-xl border border-accent/25 bg-accent/10 text-accent">
          <Icon className="size-[18px]" aria-hidden="true" />
        </span>
        {label}
      </div>
      <p className="mt-4 truncate text-2xl font-semibold tracking-tight xl:text-[1.7rem]">
        {children}
      </p>
      <p className="mt-1 min-h-5 text-xs text-subtle">{hint}</p>
    </motion.li>
  );
}

function StatCards({ overview }: { overview: Overview }) {
  const latest = overview.recentRuns[0];
  return (
    <motion.ul
      initial="hidden"
      animate="shown"
      variants={{ shown: { transition: { staggerChildren: 0.06 } } }}
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
    >
      <StatCard icon={Users} label="Employees" hint="Active in this company">
        <span className="tabular">
          <AnimatedNumber value={overview.employeeCount} format={formatCount} />
        </span>
      </StatCard>
      <StatCard
        icon={CalendarDays}
        label="Latest run"
        hint={latest ? `${formatCount(latest.entryCount)} employees, ${latest.status}` : undefined}
      >
        {latest ? formatPeriod(latest.period) : <span className="text-subtle">None yet</span>}
      </StatCard>
      <StatCard
        icon={Banknote}
        label="Total net pay"
        hint={latest ? `${formatPeriod(latest.period)} run, MUR` : undefined}
      >
        {overview.latestRunNetPay === null ? (
          <span className="text-subtle">Rs –</span>
        ) : (
          <span className="tabular">
            <AnimatedNumber value={overview.latestRunNetPay} format={formatMoney} />
          </span>
        )}
      </StatCard>
      <StatCard icon={Layers} label="Payroll runs" hint="Saved for this company">
        <span className="tabular">
          <AnimatedNumber value={overview.runCount} format={formatCount} />
        </span>
      </StatCard>
    </motion.ul>
  );
}

function RunsIllustration() {
  return (
    <svg viewBox="0 0 120 80" fill="none" aria-hidden="true" className="h-20 w-30">
      <rect x="14" y="10" width="92" height="60" rx="8" stroke="var(--line-strong)" />
      <path d="M14 26h92" stroke="var(--line-strong)" />
      <rect x="24" y="36" width="34" height="5" rx="2.5" fill="var(--line-strong)" />
      <rect x="24" y="48" width="52" height="5" rx="2.5" fill="var(--line)" />
      <circle cx="90" cy="46" r="9" stroke="var(--accent)" strokeDasharray="3 3" />
      <path d="M90 42v8M86 46h8" stroke="var(--accent)" strokeLinecap="round" />
    </svg>
  );
}

function RecentRuns({ runs, userId }: { runs: RunSummary[]; userId: string | undefined }) {
  const { isAdmin } = useCompany();

  if (runs.length === 0) {
    return (
      <EmptyState illustration={<RunsIllustration />} title="No payroll runs yet">
        {isAdmin
          ? "Import a payroll JSON export to create the first run for this company."
          : "An admin needs to import a payroll export before anything shows here."}
      </EmptyState>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {runs.map((run) => (
        <li key={run.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5">
          <Link
            to={`/explorer?run=${run.id}`}
            className="min-w-36 font-medium underline-offset-4 hover:underline"
          >
            {formatPeriod(run.period)}
          </Link>
          <Badge tone={run.status === "approved" ? "accent" : "warn"}>{run.status}</Badge>
          <span className="text-sm text-muted">
            <span className="tabular">{formatCount(run.entryCount)}</span>{" "}
            {run.entryCount === 1 ? "employee" : "employees"}
          </span>
          <span className="ml-auto text-right text-xs text-subtle">
            {run.createdBy === null
              ? "Created"
              : run.createdBy === userId
                ? "Created by you"
                : "Created by another user"}
            {" · "}
            <time dateTime={run.createdAt}>{formatDateTime(run.createdAt)}</time>
          </span>
        </li>
      ))}
    </ul>
  );
}

function QuickAction({
  to,
  icon: Icon,
  label,
  disabledReason,
}: {
  to: string;
  icon: LucideIcon;
  label: string;
  disabledReason?: string;
}) {
  const className =
    "flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-sm font-medium shadow-inner-glow transition-colors";

  if (disabledReason) {
    return (
      <Tooltip label={disabledReason} side="left">
        <button
          type="button"
          aria-disabled="true"
          aria-label={`${label} (unavailable: ${disabledReason})`}
          className={cn(className, "w-full cursor-not-allowed text-subtle")}
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </button>
      </Tooltip>
    );
  }
  return (
    <Link
      to={to}
      className={cn(className, "group text-fg hover:border-line-strong hover:bg-surface-hover")}
    >
      <Icon className="size-4 text-accent" aria-hidden="true" />
      <span className="flex-1">{label}</span>
      <ArrowUpRight
        className="size-4 text-subtle transition-colors group-hover:text-accent"
        aria-hidden="true"
      />
    </Link>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading overview" className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-36 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-3">
        <Skeleton className="h-72 rounded-2xl xl:col-span-2" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    </div>
  );
}

function CompanyOverview({ companyId }: { companyId: string }) {
  const { user } = useAuth();
  const { isAdmin } = useCompany();
  const health = useAppHealth();
  const transfers = useStore(transferLog);
  const query = useQuery({
    queryKey: ["overview", companyId, user?.id],
    queryFn: () => fetchOverview({ id: user!.id, isDemo: user!.isDemo }, companyId),
    enabled: user !== null,
  });

  if (query.isPending) return <OverviewSkeleton />;
  if (query.isError) {
    return <ErrorState failure={classifyDataError(query.error)} onRetry={() => query.refetch()} />;
  }

  const overview = query.data;
  return (
    <div className="space-y-6">
      <StatCards overview={overview} />

      <motion.div
        initial="hidden"
        animate="shown"
        variants={{ shown: { transition: { staggerChildren: 0.06, delayChildren: 0.15 } } }}
        className="grid gap-6 xl:grid-cols-3"
      >
        <Panel
          title="Recent payroll runs"
          className="xl:col-span-2"
          aside={
            <Link
              to="/history"
              className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
            >
              All runs
            </Link>
          }
        >
          <RecentRuns runs={overview.recentRuns} userId={user?.id} />
        </Panel>

        <Panel title="Quick actions">
          <div className="space-y-2.5 p-4">
            <QuickAction
              to="/import"
              icon={Upload}
              label="Import JSON"
              disabledReason={isAdmin ? undefined : "Only admins of this company can import."}
            />
            <QuickAction to="/transfer" icon={ArrowLeftRight} label="New transfer" />
            <QuickAction to="/workspace" icon={AppWindow} label="Open an app" />
          </div>
        </Panel>

        <Panel
          title="Apps"
          className="xl:col-span-2"
          aside={
            <Link
              to="/workspace"
              className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
            >
              Workspace
            </Link>
          }
        >
          <ul className="grid gap-3 p-4 sm:grid-cols-3">
            {APPS.map((app) => {
              const view = healthView(health[app.id]);
              const body = (
                <>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <app.icon
                      className="size-4 shrink-0"
                      style={{ color: app.accentColor }}
                      aria-hidden="true"
                    />
                    <span className="truncate">{app.name}</span>
                  </p>
                  <p className="mt-2 flex items-center gap-2 text-xs text-muted">
                    <StatusDot tone={view.tone} />
                    {view.label}
                  </p>
                </>
              );
              const box = "block h-full rounded-xl border border-line bg-surface p-4";
              return (
                <li key={app.id}>
                  {app.status === "active" ? (
                    <Link
                      to={`/workspace?app=${app.id}`}
                      className={cn(box, "transition-colors hover:border-line-strong")}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={box}>{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>

        <Panel
          title="Recent transfers"
          aside={
            <Link
              to="/log"
              className="text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
            >
              Full log
            </Link>
          }
        >
          {transfers.length === 0 ? (
            <EmptyState title="No transfers this session" className="py-9">
              Transfers between apps will be listed here. Nothing is kept after you sign out.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {transfers.slice(0, 5).map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
                >
                  <span className="tabular text-xs text-subtle">{clock.format(entry.at)}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {entry.from} to {entry.toName}
                    <span className="text-muted">
                      , <span className="tabular">{formatCount(entry.rowCount)}</span> rows
                    </span>
                  </span>
                  <StatusBadge entry={entry} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </motion.div>
    </div>
  );
}

function NoCompanyIllustration() {
  return (
    <svg viewBox="0 0 120 80" fill="none" aria-hidden="true" className="h-20 w-30">
      <rect x="34" y="18" width="52" height="52" rx="6" stroke="var(--line-strong)" />
      <path
        d="M46 32h8M66 32h8M46 44h8M66 44h8M54 70V58h12v12"
        stroke="var(--line-strong)"
        strokeLinecap="round"
      />
      <circle cx="92" cy="20" r="10" stroke="var(--warn)" strokeDasharray="3 3" />
      <path d="M92 15v6M92 25v.5" stroke="var(--warn)" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

export function OverviewPage() {
  const { user } = useAuth();
  const { status, failure, retry, current } = useCompany();

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          current ? (
            <>
              {current.company.name}
              {user?.isDemo && " · demo workspace with fake data"}
            </>
          ) : (
            "Headline figures and recent payroll runs."
          )
        }
      />
      <div className="mt-8">
        {status === "loading" && <OverviewSkeleton />}
        {status === "error" && failure && <ErrorState failure={failure} onRetry={retry} />}
        {status === "ready" && !current && (
          <div className="glass rounded-2xl">
            <EmptyState
              illustration={<NoCompanyIllustration />}
              title="You're not a member of any company yet"
              className="py-16"
            >
              Your sign-in works, but no company has been shared with this account. Ask the owner to
              add you as a member, then reload.
            </EmptyState>
          </div>
        )}
        {status === "ready" && current && (
          <CompanyOverview key={current.company.id} companyId={current.company.id} />
        )}
      </div>
    </>
  );
}

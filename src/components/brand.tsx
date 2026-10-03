import { cn } from "@/lib/utils";

/** Hub mark: one node connected to three. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true" className={cn("size-8", className)}>
      <rect
        width="32"
        height="32"
        rx="9"
        fill="color-mix(in srgb, var(--accent) 14%, transparent)"
        stroke="color-mix(in srgb, var(--accent) 40%, transparent)"
      />
      <path
        d="M9 10.5 13 14M23 10.5 19 14M16 20v3.5"
        stroke="var(--accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity=".7"
      />
      <circle cx="16" cy="16" r="4" fill="var(--accent)" />
      <circle cx="7.5" cy="9" r="2.5" fill="var(--accent)" opacity=".6" />
      <circle cx="24.5" cy="9" r="2.5" fill="var(--accent)" opacity=".6" />
      <circle cx="16" cy="25.5" r="2.5" fill="var(--accent)" opacity=".6" />
    </svg>
  );
}

/** Slow aurora glow behind everything. Purely decorative. */
export function AuroraBackground({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
    >
      <div className="absolute -inset-[20%] animate-drift bg-[radial-gradient(40%_35%_at_18%_12%,var(--aurora-a),transparent_70%),radial-gradient(35%_40%_at_85%_8%,var(--aurora-b),transparent_70%),radial-gradient(45%_40%_at_60%_100%,var(--aurora-c),transparent_70%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(var(--line)_1px,transparent_1px),linear-gradient(90deg,var(--line)_1px,transparent_1px)] mask-[radial-gradient(ellipse_at_top,black,transparent_70%)] bg-[size:56px_56px] opacity-40" />
    </div>
  );
}

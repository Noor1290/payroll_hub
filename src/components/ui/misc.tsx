import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Placeholder block shown while content loads. Decorative: pair it with aria-busy on the region. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "animate-shimmer rounded-md bg-[linear-gradient(90deg,var(--surface)_25%,var(--surface-hover)_50%,var(--surface)_75%)] bg-[length:200%_100%]",
        className,
      )}
      {...props}
    />
  );
}

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide uppercase",
  {
    variants: {
      tone: {
        neutral: "border-line bg-surface text-muted",
        accent: "border-accent/30 bg-accent/10 text-accent",
        warn: "border-warn/30 bg-warn/10 text-warn",
        danger: "border-danger/30 bg-danger/10 text-danger",
        glow: "border-glow/30 bg-glow/10 text-glow",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface px-1 font-mono text-[11px] text-muted",
        className,
      )}
      {...props}
    />
  );
}

export type StatusTone = "ready" | "pending" | "error" | "idle" | "detached";

const DOT_TONES: Record<StatusTone, string> = {
  ready: "bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)]",
  pending:
    "animate-pulse-dot bg-warn shadow-[0_0_0_3px_color-mix(in_srgb,var(--warn)_22%,transparent)]",
  error: "bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_22%,transparent)]",
  idle: "bg-subtle/60",
  // Hollow violet ring: the app is there, but nothing is connected to it.
  detached: "border-2 border-glow bg-transparent",
};

/** Coloured dot. Colour is never the only signal: always give it a text label nearby or via tooltip. */
export function StatusDot({ tone, className }: { tone: StatusTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 rounded-full", DOT_TONES[tone], className)}
    />
  );
}

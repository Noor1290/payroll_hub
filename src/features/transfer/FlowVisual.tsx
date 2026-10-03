import { motion } from "framer-motion";
import { Check, Database, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type FlowState = "idle" | "sending" | "delivered" | "failed";

export interface FlowEnd {
  label: string;
  icon?: LucideIcon;
  /** CSS colour for the icon. */
  color?: string;
}

const LINE: Record<FlowState, string> = {
  idle: "bg-line-strong",
  sending: "bg-warn/50",
  delivered: "bg-accent",
  failed: "bg-danger/60",
};

function Node({ end, tone }: { end: FlowEnd; tone: string }) {
  const Icon = end.icon ?? Database;
  return (
    <div className="flex w-28 shrink-0 flex-col items-center gap-2 text-center sm:w-36">
      <span
        className={cn(
          "grid size-14 place-items-center rounded-2xl border bg-surface shadow-inner-glow",
          tone,
        )}
      >
        <Icon
          className="size-6"
          style={{ color: end.color ?? "var(--accent)" }}
          aria-hidden="true"
        />
      </span>
      <span className="text-sm font-medium">{end.label}</span>
    </div>
  );
}

/**
 * Source -> destination, with the line between them showing what is happening: dots travelling
 * while sending, solid green when delivered, red when it failed. Decorative: the status is
 * always stated in text next to it. With reduced motion the dots simply don't move.
 */
export function FlowVisual({ from, to, state }: { from: FlowEnd; to: FlowEnd; state: FlowState }) {
  const border =
    state === "delivered"
      ? "border-accent/50"
      : state === "failed"
        ? "border-danger/50"
        : state === "sending"
          ? "border-warn/50"
          : "border-line";

  return (
    <div className="flex items-start justify-center" aria-hidden="true">
      <Node end={from} tone={state === "failed" ? "border-line" : border} />
      <div className="relative mt-7 h-0.5 min-w-16 flex-1 sm:max-w-72">
        <div
          className={cn(
            "absolute inset-0 rounded-full transition-colors duration-300",
            LINE[state],
          )}
        />
        {state === "sending" &&
          [0, 1, 2].map((dot) => (
            <motion.span
              key={dot}
              className="absolute -top-[5px] size-3 rounded-full bg-warn shadow-[0_0_12px_var(--warn)]"
              initial={{ left: "0%", opacity: 0 }}
              animate={{ left: ["0%", "100%"], opacity: [0, 1, 1, 0] }}
              transition={{ duration: 1.5, repeat: Infinity, delay: dot * 0.5, ease: "easeInOut" }}
            />
          ))}
        {(state === "delivered" || state === "failed") && (
          <motion.span
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 320, damping: 20 }}
            className={cn(
              "absolute -top-3.5 left-1/2 grid size-7 -translate-x-1/2 place-items-center rounded-full text-canvas",
              state === "delivered" ? "bg-accent" : "bg-danger",
            )}
          >
            {state === "delivered" ? <Check className="size-4" /> : <X className="size-4" />}
          </motion.span>
        )}
      </div>
      <Node end={to} tone={border} />
    </div>
  );
}

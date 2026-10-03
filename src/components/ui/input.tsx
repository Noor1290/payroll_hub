import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-lg border border-line bg-canvas/60 px-3.5 text-[15px] text-fg shadow-inner-glow transition-colors placeholder:text-subtle hover:border-line-strong focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/40 disabled:opacity-50 aria-invalid:border-danger",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

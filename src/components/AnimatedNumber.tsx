import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "framer-motion";

/**
 * Counts up to `value`. The moving digits are hidden from assistive tech, which reads the
 * final value once instead. `format` must be a stable function (define it at module level).
 */
export function AnimatedNumber({
  value,
  format,
}: {
  value: number;
  format: (value: number) => string;
}) {
  const reduceMotion = useReducedMotion();
  const node = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);

  useEffect(() => {
    const element = node.current;
    if (!element) return;
    if (reduceMotion) {
      shown.current = value;
      element.textContent = format(value);
      return;
    }
    const controls = animate(shown.current, value, {
      duration: 0.9,
      ease: "easeOut",
      onUpdate: (latest) => {
        shown.current = latest;
        element.textContent = format(latest);
      },
    });
    return () => controls.stop();
  }, [value, format, reduceMotion]);

  return (
    <>
      <span ref={node} aria-hidden="true" />
      <span className="sr-only">{format(value)}</span>
    </>
  );
}

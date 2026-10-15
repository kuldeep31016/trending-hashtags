import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Animate a number: from 0 on first appearance, then from the previous value to the new one
 * whenever a new MapReduce window changes it. Reduced motion -> jumps straight to the value.
 */
export function useCountUp(target: number | null | undefined, duration = 900): number | null {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState<number | null>(target == null ? null : reduce ? target : 0);
  const from = useRef(0);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (target == null) {
      setShown(null);
      return;
    }
    if (reduce) {
      setShown(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const a = from.current;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const v = a + (target - a) * easeOut(t);
      setShown(v);
      from.current = v;
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [target, duration, reduce]);

  return shown;
}

export function CountUp({
  value,
  format = (v) => Math.round(v).toLocaleString(),
  duration,
  className,
}: {
  value: number | null | undefined;
  format?: (v: number) => string;
  duration?: number;
  className?: string;
}) {
  const v = useCountUp(value, duration);
  return (
    <span className={className} aria-label={value == null ? undefined : format(value)}>
      <span aria-hidden>{v == null ? "—" : format(v)}</span>
    </span>
  );
}

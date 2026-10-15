"use client";

import { useEffect, useRef, useState } from "react";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Counts from the previously shown value to `value`. Skips animation for
 * users who prefer reduced motion.
 */
export function AnimatedNumber({
  value,
  format,
  duration = 700,
}: {
  value: number;
  format: (v: number) => string;
  duration?: number;
}) {
  const [display, setDisplay] = useState(value);
  const from = useRef(0);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = from.current;
    if (reduced || start === value) {
      setDisplay(value);
      from.current = value;
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const v = start + (value - start) * easeOutCubic(p);
      setDisplay(v);
      from.current = v;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return <span className="tabular">{format(display)}</span>;
}

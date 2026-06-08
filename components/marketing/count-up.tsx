'use client';

import { useInView, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

// Compteur count-up déclenché au scroll (une fois). Sous reduced-motion :
// affiche directement la valeur finale. Chiffres en mono tnum.
type CountUpProps = {
  value: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
};

export function CountUp({
  value,
  prefix = '',
  suffix = '',
  duration = 1.4,
  className,
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '-60px' });
  const reduce = useReducedMotion();
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setDisplay(value);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / (duration * 1000), 1);
      const eased = 1 - (1 - p) ** 3;
      setDisplay(Math.round(eased * value));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, duration, reduce]);

  return (
    <span ref={ref} className={`font-mono tabular-nums ${className ?? ''}`}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

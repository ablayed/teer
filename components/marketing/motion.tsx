'use client';

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

// Primitives reveal au scroll, SANS lib d'animation (zéro framer-motion sur la
// landing). IntersectionObserver + transitions CSS (cf. .reveal/.stagger dans
// globals.css). reduced-motion géré en CSS. Le contenu reste dans le DOM.

function useInViewOnce<T extends Element>(margin = '-80px') {
  const ref = useRef<T>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            io.disconnect();
          }
        }
      },
      { rootMargin: margin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown, margin]);

  return { ref, shown };
}

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
};

/** Fade + rise au scroll (une fois). */
export function Reveal({ children, className, delay = 0, y = 16 }: RevealProps) {
  const { ref, shown } = useInViewOnce<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-shown={shown}
      className={`reveal ${className ?? ''}`}
      style={{ '--reveal-y': `${y}px`, '--reveal-delay': `${delay * 1000}ms` } as CSSProperties}
    >
      {children}
    </div>
  );
}

/** Conteneur qui décale l'apparition de ses <StaggerItem> (délais en CSS, nth-child). */
export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  const { ref, shown } = useInViewOnce<HTMLDivElement>();
  return (
    <div ref={ref} data-shown={shown} className={`stagger ${className ?? ''}`}>
      {children}
    </div>
  );
}

/** Élément animé par un <Stagger> parent (visibilité pilotée par le parent). */
export function StaggerItem({
  children,
  className,
  y = 16,
}: {
  children: ReactNode;
  className?: string;
  y?: number;
}) {
  return (
    <div
      className={`reveal ${className ?? ''}`}
      style={{ '--reveal-y': `${y}px` } as CSSProperties}
    >
      {children}
    </div>
  );
}

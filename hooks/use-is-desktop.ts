'use client';

import { useEffect, useLayoutEffect, useState } from 'react';

// useLayoutEffect sur client (fire avant le premier paint → pas de race avec Playwright),
// useEffect sur serveur (no-op de toute façon, mais évite le warning SSR de React).
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)');

    function handleChange() {
      setIsDesktop(mql.matches);
    }

    handleChange();
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);

  return isDesktop;
}

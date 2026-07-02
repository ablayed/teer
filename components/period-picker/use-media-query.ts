'use client';

import { useEffect, useState } from 'react';

// SSR-safe : renvoie `false` au rendu serveur et au premier rendu client (avant
// montage), puis se synchronise. Le PeriodPicker s'appuie dessus derrière un flag
// `mounted` pour ne jamais diverger à l'hydratation.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

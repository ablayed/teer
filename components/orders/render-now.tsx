'use client';

import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';

// Horloge déterministe du rendu (V2). Les libellés relatifs (« il y a 5 min », « Aujourd'hui »)
// dépendent de l'heure. Calculés avec `Date.now()` pendant le rendu, ils diffèrent entre le HTML
// produit par le serveur et le premier rendu du navigateur : React signale un écart d'hydratation
// (#418/#419/#421) et peut refaire l'arbre côté client.
//
// Le serveur fournit donc UN instant, `serverNow`, écrit dans la charge utile : le rendu serveur et
// le premier rendu du navigateur utilisent exactement la même valeur. L'heure réelle n'est lue
// qu'APRÈS le montage, une seule fois : les libellés relatifs se corrigent alors, sans minuterie ni
// scrutation.
const RenderNowContext = createContext<Date | null>(null);

export function RenderNowProvider({
  children,
  serverNow,
}: {
  children: ReactNode;
  serverNow: string;
}) {
  const [now, setNow] = useState(() => new Date(serverNow));

  useEffect(() => {
    setNow(new Date());
  }, []);

  return <RenderNowContext.Provider value={now}>{children}</RenderNowContext.Provider>;
}

/** L'instant du rendu. Hors fournisseur : l'heure courante (comportement d'avant V2). */
export function useRenderNow(): Date {
  return useContext(RenderNowContext) ?? new Date();
}

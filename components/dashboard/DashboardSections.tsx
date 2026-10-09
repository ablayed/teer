'use client';

import React from 'react';

type DashboardSectionsProps = {
  children: React.ReactNode;
};

// L07 — conteneur des blocs du Tableau. Il remplace l'ancien enrobage animé, qui servait chaque
// bloc à `opacity: 0` et attendait l'hydratation pour le révéler : squelettes compris, rien
// n'était visible tant que le JavaScript n'avait pas démarré. Ce composant est présent dans le
// HTML initial comme tout composant client, et aucun style n'y masque le contenu.
//
// La structure est conservée à l'identique : un `div` par enfant direct, pour que `space-y-8`
// produise les mêmes marges (y compris quand un enfant ne rend rien) et que les clés des
// `Suspense` restent portées par des enfants distincts.
//
// NE PAS en faire un composant serveur. Mesuré le 2026-10-09 sur build de production : sans
// `'use client'`, après un changement de période, un bloc reste sur les valeurs de la période
// précédente dans 11 essais sur 24 (tests/e2e/tableau-period.spec.ts, « les deux blocs
// historiques suivent le preset de période »), contre 0 sur 32 avec cette frontière cliente et
// 0 sur 32 avec l'ancien enrobage. La cause n'est pas établie ; la frontière cliente est gardée
// délibérément.
export function DashboardSections({ children }: DashboardSectionsProps) {
  return (
    <div className="space-y-8">
      {React.Children.map(children, (child) => (
        <div>{child}</div>
      ))}
    </div>
  );
}

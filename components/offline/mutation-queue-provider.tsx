'use client';

import {
  createProductAdSpendAction,
  setPurchaseLotLineWeightAction,
} from '@/lib/actions/purchases';
import { initMutationQueueAutoFlush } from '@/lib/offline/mutation-queue';
import { useEffect } from 'react';

/**
 * Réessai automatique au retour réseau (exigence F2 non négociable) — sans ce
 * composant, `initMutationQueueAutoFlush` (lib/offline/mutation-queue.ts) existe
 * mais n'est jamais appelé : la seule chose qui vidait la file IndexedDB était
 * un nouvel appel manuel à `useQueuedAction(...).submit(...)` sur le MÊME
 * formulaire, ce qui n'arrive que si l'utilisateur ressaisit ce formulaire précis.
 *
 * Monté UNE SEULE FOIS près de la racine de l'appli authentifiée (même
 * convention que `AnalyticsProvider`, `app/(app)/layout.tsx`) — jamais par page,
 * pour ne pas dupliquer les listeners `online` ni les tentatives de flush.
 *
 * Un exécuteur par `kind` de mutation actuellement en file côté F2 :
 * `set_purchase_lot_line_weight` (poids de ligne d'arrivage) et `create_ad_spend`
 * (dépense publicitaire). Chaque enveloppe reproduit EXACTEMENT le contrat
 * `(input: unknown) => Promise<{ ok: boolean }>` attendu par
 * `flushMutationQueue` — même normalisation `Boolean(res?.data?.ok)` que
 * `purchase-lot-detail-panel.tsx`/`product-ad-spend-form.tsx`, pour rester
 * cohérent si l'action échoue autrement qu'en levant (ex. FORBIDDEN aplati par
 * next-safe-action).
 *
 * Concurrence avec les flushes locaux de `useQueuedAction` : SANS RISQUE de
 * double exécution. `flushMutationQueue` relit `listQueuedMutations()` (donc
 * l'état COURANT d'IndexedDB) à chaque appel, exécute l'exécuteur, puis
 * supprime l'enregistrement seulement sur `{ok:true}` — deux flushes concurrents
 * (un global ici, un local dans un formulaire) peuvent chacun lire le même
 * enregistrement encore présent et appeler l'exécuteur deux fois pour la MÊME
 * mutation avant que la suppression ne soit visible. Ce n'est pas une double
 * écriture serveur grâce à l'idempotence portée par l'appelant : `set_weight`
 * est un upsert de valeur absolue (rejouer la même valeur est sans effet) et
 * `create_ad_spend` est dédupliqué par `clientRequestId` → `external_ref`
 * (contrainte unique). L'INVARIANT réel exigé ici n'est PAS "la tentative en
 * double échoue" mais l'inverse : `createProductAdSpendAction`
 * (lib/actions/purchases.ts) intercepte le `23505` sur cette contrainte et le
 * convertit en SUCCÈS (`{ ok: true, alreadyRecorded: true }`), jamais en échec.
 * C'est cette conversion qui neutralise la course : puisque `flushMutationQueue`
 * ne supprime l'enregistrement QUE sur `{ok:true}`, un exécuteur qui renverrait
 * `ok:false` sur ce `23505` laisserait le racer perdant `store.put` un
 * enregistrement que le racer gagnant vient de `store.delete` — une entrée de
 * file zombie, rejouée indéfiniment sans jamais pouvoir réussir (la même
 * tentative refera toujours 23505). Tout futur exécuteur ajouté à ce provider
 * doit respecter la même règle : renvoyer `ok:true` quand il rejoue une
 * mutation déjà appliquée, pas seulement "échouer proprement".
 */
export function MutationQueueProvider() {
  useEffect(() => {
    return initMutationQueueAutoFlush({
      set_purchase_lot_line_weight: async (input: unknown) => {
        const res = await setPurchaseLotLineWeightAction(
          input as Parameters<typeof setPurchaseLotLineWeightAction>[0],
        );
        return { ok: Boolean(res?.data?.ok) };
      },
      create_ad_spend: async (input: unknown) => {
        const res = await createProductAdSpendAction(
          input as Parameters<typeof createProductAdSpendAction>[0],
        );
        return { ok: Boolean(res?.data?.ok) };
      },
    });
  }, []);

  return null;
}

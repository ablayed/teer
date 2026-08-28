'use client';

import { createProductAdSpendAction } from '@/lib/actions/purchases';
import { type QueuedActionState, useQueuedAction } from '@/lib/offline/use-queued-action';
import { useEffect, useRef, useState } from 'react';

export type ProductAdSpendCandidateLot = { id: string; label: string };

// Libellés de bouton REPRIS TELS QUELS de `WEIGHT_BUTTON_LABEL`
// (components/purchases/purchase-lot-detail-panel.tsx), y compris le tiret cadratin —
// pattern déjà revu deux fois sur ce fichier, ne pas le retaper de mémoire.
const AD_SPEND_BUTTON_LABEL: Record<QueuedActionState, string> = {
  idle: 'Enregistrer',
  saving: 'Enregistrement…',
  queued: "Enregistré sur l'appareil — en attente de synchronisation",
  synced: 'Enregistré',
  error: 'Réessayer',
};

/**
 * Saisie d'une dépense publicitaire (Lot F2) — TOUJOURS produit + arrivage + période +
 * montant, jamais un arrivage optionnel ou choisi par défaut silencieusement :
 *
 * - `lockedPurchaseLotId` posé (ouverture depuis la Fiche arrivage, contexte lot déjà
 *   connu) : l'arrivage s'affiche en lecture seule, jamais re-demandé.
 * - `candidateLots` posé (ouverture depuis la fiche produit, lot inconnu a priori) :
 *   un `<select>` requis, jamais de présélection sur plusieurs candidats. À exactement
 *   un candidat, il est PRÉSÉLECTIONNÉ mais reste affiché (le marchand voit quel
 *   arrivage est débité). À zéro candidat, la soumission est bloquée avec un message
 *   explicite — `createProductAdSpendAction` rejetterait de toute façon un
 *   (productId, purchaseLotId) sans ligne d'arrivage réelle les reliant.
 */
export function ProductAdSpendForm({
  productId,
  productLabel,
  lockedPurchaseLotId,
  lockedPurchaseLotLabel,
  candidateLots,
  onDone,
}: {
  productId: string;
  productLabel?: string;
  lockedPurchaseLotId?: string;
  lockedPurchaseLotLabel?: string;
  candidateLots?: ProductAdSpendCandidateLot[];
  onDone: () => void;
}) {
  const [purchaseLotId, setPurchaseLotId] = useState(
    lockedPurchaseLotId ?? (candidateLots?.length === 1 ? candidateLots[0].id : ''),
  );
  const [amountText, setAmountText] = useState('');
  const [amountError, setAmountError] = useState<string | null>(null);
  const [spentAt, setSpentAt] = useState(() => new Date().toISOString().slice(0, 10));

  // Un seul identifiant client par soumission logique : généré au premier clic sur
  // « Enregistrer », puis RÉUTILISÉ tel quel si l'utilisateur clique de nouveau après
  // une erreur (« Réessayer ») — jamais régénéré à chaque clic. Servant à la fois de
  // clé d'idempotence côté file de mutation (id d'enregistrement IndexedDB) ET de
  // `clientRequestId` côté serveur (colonne `external_ref`, index unique) : les deux
  // DOIVENT être la même valeur pour qu'une nouvelle tentative de la MÊME soumission
  // logique soit reconnue comme un doublon plutôt que comme une deuxième dépense.
  const requestIdRef = useRef<string | null>(null);

  const queued = useQueuedAction(
    'create_ad_spend',
    async (input: Parameters<typeof createProductAdSpendAction>[0]) => {
      const res = await createProductAdSpendAction(input);
      return {
        ok: Boolean(res?.data?.ok),
        message: res?.data?.ok ? undefined : res?.data?.message,
      };
    },
  );

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // La notification du parent ne se déclenche QUE sur un vrai règlement observé via
  // l'état du hook — `synced`, jamais `queued` (même règle que `WeightEditorRow`,
  // purchase-lot-detail-panel.tsx : ce composant suit le même `useEffect` plutôt que
  // de relire `queued.state` juste après l'await, pour éviter le bug de closure figée
  // déjà écarté là-bas). `queued` signifie seulement « posé dans la file IndexedDB
  // durable », pas confirmé par le serveur — le formulaire doit rester ouvert et
  // afficher le libellé « en attente de synchronisation » jusqu'au règlement réel.
  useEffect(() => {
    if (queued.state === 'synced') {
      onDoneRef.current();
    }
  }, [queued.state]);

  function formatThousands(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    return digits ? Number(digits).toLocaleString('fr-FR') : '';
  }

  function validateAmountOnBlur(): boolean {
    const digits = amountText.replace(/\D/g, '');
    if (!digits || Number(digits) <= 0) {
      setAmountError('Montant requis, supérieur à 0.');
      return false;
    }
    setAmountError(null);
    return true;
  }

  const noCandidateLot =
    !lockedPurchaseLotId && candidateLots != null && candidateLots.length === 0;

  async function handleSubmit() {
    const amountValid = validateAmountOnBlur();
    if (!purchaseLotId || !amountValid || noCandidateLot) return;

    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID();
    const requestId = requestIdRef.current;
    const digits = amountText.replace(/\D/g, '');

    await queued.submit(
      {
        productId,
        purchaseLotId,
        amountMinor: Number(digits),
        spentAt,
        clientRequestId: requestId,
      },
      requestId,
    );
  }

  const submitDisabled =
    queued.state === 'saving' || queued.state === 'synced' || !purchaseLotId || noCandidateLot;

  return (
    <div className="space-y-4" data-testid="product-ad-spend-form">
      {productLabel && <p className="text-sm text-muted">Produit : {productLabel}</p>}

      {lockedPurchaseLotId ? (
        <div className="space-y-1">
          <span className="block text-sm font-medium text-text">Arrivage</span>
          <p
            className="flex min-h-11 items-center rounded-md border border-border bg-canvas px-3 text-sm text-muted"
            data-testid="ad-spend-lot-locked"
          >
            {lockedPurchaseLotLabel ?? lockedPurchaseLotId}
          </p>
        </div>
      ) : candidateLots && candidateLots.length > 0 ? (
        <label className="block space-y-1">
          <span className="text-sm font-medium text-text">Arrivage *</span>
          <select
            required
            value={purchaseLotId}
            onChange={(e) => setPurchaseLotId(e.target.value)}
            className="min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            data-testid="ad-spend-lot-select"
          >
            <option value="">Sélectionnez l'arrivage concerné…</option>
            {candidateLots.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : noCandidateLot ? (
        <p className="text-sm text-warning" role="alert" data-testid="ad-spend-no-lot">
          Ce produit n'a pas encore d'arrivage reçu — la dépense publicitaire doit être rattachée à
          un arrivage.
        </p>
      ) : null}

      <label className="block space-y-1">
        <span className="text-sm font-medium text-text">Montant</span>
        <div className="relative">
          <input
            inputMode="numeric"
            value={amountText}
            onChange={(e) => setAmountText(formatThousands(e.target.value))}
            onBlur={validateAmountOnBlur}
            className="min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 pr-16 text-sm font-mono tabular-nums"
            placeholder="0"
            aria-describedby={amountError ? 'ad-spend-amount-error' : undefined}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">
            F CFA
          </span>
        </div>
        {amountError && (
          <span className="text-xs text-danger" id="ad-spend-amount-error" role="alert">
            {amountError}
          </span>
        )}
      </label>

      <label className="block space-y-1">
        <span className="text-sm font-medium text-text">Date de la dépense</span>
        <input
          type="date"
          value={spentAt}
          onChange={(e) => setSpentAt(e.target.value)}
          className="min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
        />
      </label>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={submitDisabled}
        className="min-h-[44px] w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
        data-testid="ad-spend-submit"
      >
        {AD_SPEND_BUTTON_LABEL[queued.state]}
      </button>
      {queued.state === 'error' && queued.errorMessage && (
        <p className="text-xs text-danger" role="alert">
          {queued.errorMessage}
        </p>
      )}
    </div>
  );
}

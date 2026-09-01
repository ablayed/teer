'use client';

import { recordSettlementAction } from '@/lib/actions/finance';
import { settlementMethods } from '@/lib/finance/cash';
import { formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useRef, useState } from 'react';

type Props = {
  driverId: string;
  // Solde live affiché par la carte "Cash chez le livreur (live)" au moment du
  // rendu — "montant attendu" de l'écran de confirmation. Snapshot, pas relu à
  // la confirmation : si le solde a bougé entre-temps (autre remise en //),
  // record_cash_settlement recalcule quand même server-side sur les vraies
  // allocations — ce montant n'est qu'informatif, jamais transmis à la RPC.
  expectedMinor: number;
  // Partie 2 — raccourci depuis la carte « Cash chez le livreur (live) ». Le parent
  // demande un préremplissage en incrémentant `nonce` ; ce composant reste la SEULE
  // source de vérité du montant saisi et le SEUL appelant de recordSettlementAction.
  // Aucune logique de calcul du solde n'est dupliquée ici : `amountMinor` est la
  // valeur déjà affichée par la carte (c.cashOnHandMinor), pas un recalcul client.
  prefill?: { amountMinor: number; nonce: number } | null;
  // Appelé après une remise réussie : le parent relit la conso cash FRAÎCHE côté
  // serveur et met à jour son état. On NE fait PAS de router.refresh() ici — son
  // re-render RSC à travers le composant client était racey (~27% de ratés en
  // build prod → chiffre cash périmé). Cf. lecture explicite dans DriverCashPanel.
  onSettled?: () => void;
};

const methodLabels: Record<(typeof settlementMethods)[number], string> = {
  ESPECES: 'Espèces',
  WAVE: 'Wave',
  ORANGE_MONEY: 'Orange Money',
  FREE_MONEY: 'Free Money',
};

// Remise globale par défaut : le versement couvre plusieurs commandes, réparti
// automatiquement (FIFO côté RPC) en l'absence d'allocations explicites.
export function DriverRemittanceForm({ driverId, expectedMinor, onSettled, prefill }: Props) {
  const action = useAction(recordSettlementAction);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof settlementMethods)[number]>('ESPECES');
  const [feedback, setFeedback] = useState<{ msg: string; kind: 'error' | 'success' } | null>(null);
  // Confirmation obligatoire avant tout enregistrement (CASH-01) : le premier clic
  // sur "Enregistrer le versement" n'écrit rien, il affiche un récapitulatif
  // (attendu/saisi/reste) ; seul "Confirmer le versement" appelle la RPC.
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const amountInputRef = useRef<HTMLInputElement>(null);

  // Le montant reste librement modifiable après préremplissage : la carte propose
  // le solde complet, le marchand peut saisir une remise partielle. On dépend du
  // `nonce` et non de la valeur, pour qu'un second clic sur un solde inchangé
  // réapplique bien la proposition après une saisie manuelle.
  const prefillNonce = prefill?.nonce;
  const prefillAmountMinor = prefill?.amountMinor;
  useEffect(() => {
    if (prefillNonce === undefined || prefillAmountMinor === undefined) return;
    setAmount(String(prefillAmountMinor));
    setFeedback(null);
    setPendingConfirm(false);
    amountInputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    amountInputRef.current?.focus({ preventScroll: true });
  }, [prefillNonce, prefillAmountMinor]);

  function requestConfirm() {
    const a = Number.parseInt(amount, 10);
    if (!Number.isFinite(a) || a < 0) {
      setFeedback({ msg: 'Montant invalide (≥ 0).', kind: 'error' });
      return;
    }
    setFeedback(null);
    setPendingConfirm(true);
  }

  async function confirmSubmit() {
    const a = Number.parseInt(amount, 10);
    const res = await action.executeAsync({
      driverId,
      amountReceivedMinor: a,
      method,
      clientRequestId: crypto.randomUUID(),
    });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Versement enregistré.', kind: 'success' });
      setAmount('');
      setPendingConfirm(false);
      onSettled?.();
    } else {
      setFeedback({ msg: "Erreur lors de l'enregistrement du versement.", kind: 'error' });
    }
  }

  const parsedAmount = Number.parseInt(amount, 10);
  const restMinor = pendingConfirm ? Math.max(expectedMinor - parsedAmount, 0) : 0;

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="text-xs text-muted">Montant reçu (FCFA)</span>
        <input
          className="min-h-11 w-36 rounded-md border border-border bg-canvas px-2 text-sm"
          disabled={pendingConfirm}
          min="0"
          onChange={(e) => {
            setAmount(e.target.value);
            setPendingConfirm(false);
          }}
          placeholder="0"
          ref={amountInputRef}
          type="number"
          value={amount}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-muted">Moyen</span>
        <select
          className="min-h-11 w-40 rounded-md border border-border bg-canvas px-2 text-sm"
          disabled={pendingConfirm}
          onChange={(e) => {
            setMethod(e.target.value as (typeof settlementMethods)[number]);
            setPendingConfirm(false);
          }}
          value={method}
        >
          {settlementMethods.map((m) => (
            <option key={m} value={m}>
              {methodLabels[m]}
            </option>
          ))}
        </select>
      </label>
      {!pendingConfirm ? (
        <button
          className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
          onClick={requestConfirm}
          type="button"
        >
          Enregistrer le versement
        </button>
      ) : (
        <div className="flex w-full flex-col gap-2 rounded-md border border-border bg-canvas p-3 text-sm">
          <p>
            Montant attendu : <span className="font-semibold">{formatMoney(expectedMinor)}</span>
          </p>
          <p>
            Montant saisi : <span className="font-semibold">{formatMoney(parsedAmount)}</span>
          </p>
          <p>
            Reste après la remise : <span className="font-semibold">{formatMoney(restMinor)}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
              disabled={action.isExecuting}
              onClick={confirmSubmit}
              type="button"
            >
              {action.isExecuting ? 'En cours…' : 'Confirmer le versement'}
            </button>
            <button
              className="min-h-11 rounded-md border border-border px-4 text-sm font-medium text-muted hover:bg-surface"
              onClick={() => setPendingConfirm(false)}
              type="button"
            >
              Modifier
            </button>
          </div>
        </div>
      )}
      {feedback && (
        <p
          className={cn(
            'text-xs font-medium',
            feedback.kind === 'error' ? 'text-danger' : 'text-success',
          )}
          role="alert"
        >
          {feedback.msg}
        </p>
      )}
    </div>
  );
}

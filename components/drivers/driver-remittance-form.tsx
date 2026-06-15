'use client';

import { recordSettlementAction } from '@/lib/actions/finance';
import { settlementMethods } from '@/lib/finance/cash';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useState } from 'react';

type Props = {
  driverId: string;
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
export function DriverRemittanceForm({ driverId, onSettled }: Props) {
  const action = useAction(recordSettlementAction);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<(typeof settlementMethods)[number]>('ESPECES');
  const [feedback, setFeedback] = useState<{ msg: string; kind: 'error' | 'success' } | null>(null);

  async function submit() {
    const a = Number.parseInt(amount, 10);
    if (!Number.isFinite(a) || a < 0) {
      setFeedback({ msg: 'Montant invalide (≥ 0).', kind: 'error' });
      return;
    }
    const res = await action.executeAsync({
      driverId,
      amountReceivedMinor: a,
      method,
      clientRequestId: crypto.randomUUID(),
    });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Versement enregistré.', kind: 'success' });
      setAmount('');
      onSettled?.();
    } else {
      setFeedback({ msg: "Erreur lors de l'enregistrement du versement.", kind: 'error' });
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="text-xs text-muted">Montant reçu (FCFA)</span>
        <input
          className="min-h-11 w-36 rounded-md border border-border bg-canvas px-2 text-sm"
          min="0"
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          type="number"
          value={amount}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-muted">Moyen</span>
        <select
          className="min-h-11 w-40 rounded-md border border-border bg-canvas px-2 text-sm"
          onChange={(e) => setMethod(e.target.value as (typeof settlementMethods)[number])}
          value={method}
        >
          {settlementMethods.map((m) => (
            <option key={m} value={m}>
              {methodLabels[m]}
            </option>
          ))}
        </select>
      </label>
      <button
        className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
        disabled={action.isExecuting}
        onClick={submit}
        type="button"
      >
        {action.isExecuting ? 'En cours…' : 'Enregistrer le versement'}
      </button>
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

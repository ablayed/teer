'use client';

import { allocateToCourierAction, courierReturnLotAction } from '@/lib/actions/drivers';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type ProductOption = { id: string; title: string; sku: string | null };

type Props = {
  driverId: string;
  products: ProductOption[];
};

type Mode = 'allocate' | 'return';

export function DriverLotForm({ driverId, products }: Props) {
  const router = useRouter();
  const allocate = useAction(allocateToCourierAction);
  const courierReturn = useAction(courierReturnLotAction);
  const [mode, setMode] = useState<Mode>('allocate');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('');
  const [feedback, setFeedback] = useState<{ msg: string; kind: 'error' | 'success' } | null>(null);

  const isExecuting = allocate.isExecuting || courierReturn.isExecuting;

  async function submit() {
    const q = Number.parseInt(qty, 10);
    if (!productId) {
      setFeedback({ msg: 'Sélectionnez un produit.', kind: 'error' });
      return;
    }
    if (!Number.isFinite(q) || q < 1) {
      setFeedback({ msg: 'Quantité invalide (min. 1).', kind: 'error' });
      return;
    }

    const input = { driverId, productId, qty: q, clientRequestId: crypto.randomUUID() };
    const res =
      mode === 'allocate'
        ? await allocate.executeAsync(input)
        : await courierReturn.executeAsync(input);

    if (res?.data?.ok) {
      setFeedback({
        msg: mode === 'allocate' ? 'Lot alloué au livreur.' : 'Retour de lot enregistré.',
        kind: 'success',
      });
      setQty('');
      setProductId('');
      router.refresh();
    } else {
      setFeedback({ msg: res?.data?.message ?? "Erreur lors de l'enregistrement.", kind: 'error' });
    }
  }

  if (products.length === 0) {
    return (
      <p className="text-sm text-muted">
        Aucun produit actif. Ajoutez des produits au catalogue pour gérer les lots.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex rounded-lg border border-border bg-surface p-1">
        <button
          className={cn(
            'min-h-11 flex-1 rounded-md px-3 text-sm font-medium md:min-h-9',
            mode === 'allocate' ? 'bg-accent text-[#111]' : 'text-muted hover:text-text',
          )}
          onClick={() => setMode('allocate')}
          type="button"
        >
          Allouer un lot
        </button>
        <button
          className={cn(
            'min-h-11 flex-1 rounded-md px-3 text-sm font-medium md:min-h-9',
            mode === 'return' ? 'bg-accent text-[#111]' : 'text-muted hover:text-text',
          )}
          onClick={() => setMode('return')}
          type="button"
        >
          Retour de lot
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1">
          <span className="text-xs text-muted">Produit</span>
          <select
            className="min-h-11 w-56 rounded-md border border-border bg-canvas px-2 text-sm"
            onChange={(e) => setProductId(e.target.value)}
            value={productId}
          >
            <option value="">— Choisir —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
                {p.sku ? ` (${p.sku})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-xs text-muted">
            {mode === 'allocate' ? 'Qté allouée' : 'Qté retournée'}
          </span>
          <input
            className="min-h-11 w-24 rounded-md border border-border bg-canvas px-2 text-sm"
            min="1"
            onChange={(e) => setQty(e.target.value)}
            placeholder="10"
            type="number"
            value={qty}
          />
        </label>
        <button
          className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
          disabled={isExecuting}
          onClick={submit}
          type="button"
        >
          {isExecuting ? 'En cours…' : 'Valider'}
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
    </div>
  );
}

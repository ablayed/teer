'use client';

import {
  courierReturnAction,
  manualAdjustmentAction,
  purchaseInAction,
  setLowStockThresholdAction,
} from '@/lib/actions/stock';
import type { StockPageRow } from '@/lib/actions/stock';
import { formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useState } from 'react';

type Props = {
  rows: StockPageRow[];
  canSeeCost: boolean;
};

type ActiveForm =
  | { type: 'purchase'; productId: string }
  | { type: 'adjustment'; productId: string }
  | { type: 'return'; productId: string }
  | { type: 'threshold'; productId: string }
  | null;

function LowStockBadge() {
  return (
    <span className="rounded-full bg-danger-subtle px-2 py-0.5 text-xs font-medium text-danger">
      Stock bas
    </span>
  );
}

function BundleBadge() {
  return (
    <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-medium text-muted">
      Bundle
    </span>
  );
}

function InlineFeedback({ message, kind }: { message: string; kind: 'error' | 'success' }) {
  return (
    <p
      className={cn('text-xs font-medium', kind === 'error' ? 'text-danger' : 'text-success')}
      role="alert"
    >
      {message}
    </p>
  );
}

function PurchaseForm({
  productId,
  onDone,
}: {
  productId: string;
  onDone: () => void;
}) {
  const action = useAction(purchaseInAction);
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [feedback, setFeedback] = useState<{ msg: string; kind: 'error' | 'success' } | null>(null);

  async function submit() {
    const q = Number.parseInt(qty, 10);
    const c = Number.parseInt(cost, 10);
    if (!Number.isFinite(q) || q < 1) {
      setFeedback({ msg: 'Quantité invalide (min. 1).', kind: 'error' });
      return;
    }
    if (!Number.isFinite(c) || c < 0) {
      setFeedback({ msg: 'Coût invalide (≥ 0).', kind: 'error' });
      return;
    }
    const res = await action.executeAsync({ productId, qty: q, unitCost: c });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Entrée enregistrée.', kind: 'success' });
      setTimeout(onDone, 800);
    } else {
      setFeedback({ msg: "Erreur lors de l'enregistrement.", kind: 'error' });
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="text-xs text-muted">Qté reçue</span>
        <input
          className="min-h-11 w-24 rounded-md border border-border bg-canvas px-2 text-sm md:min-h-9"
          min="1"
          onChange={(e) => setQty(e.target.value)}
          placeholder="10"
          type="number"
          value={qty}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs text-muted">Coût unit. (FCFA)</span>
        <input
          className="min-h-11 w-32 rounded-md border border-border bg-canvas px-2 text-sm md:min-h-9"
          min="0"
          onChange={(e) => setCost(e.target.value)}
          placeholder="0"
          type="number"
          value={cost}
        />
      </label>
      <button
        className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60 md:min-h-9"
        disabled={action.isExecuting}
        onClick={submit}
        type="button"
      >
        {action.isExecuting ? 'En cours…' : 'Valider'}
      </button>
      <button
        className="min-h-11 rounded-md px-3 text-sm text-muted underline md:min-h-9"
        onClick={onDone}
        type="button"
      >
        Annuler
      </button>
      {feedback && <InlineFeedback kind={feedback.kind} message={feedback.msg} />}
    </div>
  );
}

function AdjustmentForm({
  productId,
  onDone,
}: {
  productId: string;
  onDone: () => void;
}) {
  const action = useAction(manualAdjustmentAction);
  const [qty, setQty] = useState('');
  const [feedback, setFeedback] = useState<{ msg: string; kind: 'error' | 'success' } | null>(null);

  async function submit() {
    const q = Number.parseInt(qty, 10);
    if (!Number.isFinite(q) || q === 0) {
      setFeedback({ msg: 'Quantité invalide (≠ 0).', kind: 'error' });
      return;
    }
    const res = await action.executeAsync({ productId, qty: q });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Ajustement enregistré.', kind: 'success' });
      setTimeout(onDone, 800);
    } else {
      setFeedback({ msg: "Erreur lors de l'ajustement.", kind: 'error' });
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="text-xs text-muted">Δ qté (+/−)</span>
        <input
          className="min-h-11 w-24 rounded-md border border-border bg-canvas px-2 text-sm md:min-h-9"
          onChange={(e) => setQty(e.target.value)}
          placeholder="-3"
          type="number"
          value={qty}
        />
      </label>
      <button
        className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60 md:min-h-9"
        disabled={action.isExecuting}
        onClick={submit}
        type="button"
      >
        {action.isExecuting ? 'En cours…' : 'Valider'}
      </button>
      <button
        className="min-h-11 rounded-md px-3 text-sm text-muted underline md:min-h-9"
        onClick={onDone}
        type="button"
      >
        Annuler
      </button>
      {feedback && <InlineFeedback kind={feedback.kind} message={feedback.msg} />}
    </div>
  );
}

function CourierReturnForm({
  productId,
  onDone,
}: {
  productId: string;
  onDone: () => void;
}) {
  const action = useAction(courierReturnAction);
  const [qty, setQty] = useState('');
  const [feedback, setFeedback] = useState<{ msg: string; kind: 'error' | 'success' } | null>(null);

  async function submit() {
    const q = Number.parseInt(qty, 10);
    if (!Number.isFinite(q) || q < 1) {
      setFeedback({ msg: 'Quantité invalide (min. 1).', kind: 'error' });
      return;
    }
    const res = await action.executeAsync({ productId, qty: q });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Retour enregistré.', kind: 'success' });
      setTimeout(onDone, 800);
    } else {
      setFeedback({ msg: "Erreur lors de l'enregistrement.", kind: 'error' });
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="text-xs text-muted">Qté retournée</span>
        <input
          className="min-h-11 w-24 rounded-md border border-border bg-canvas px-2 text-sm md:min-h-9"
          min="1"
          onChange={(e) => setQty(e.target.value)}
          placeholder="1"
          type="number"
          value={qty}
        />
      </label>
      <button
        className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60 md:min-h-9"
        disabled={action.isExecuting}
        onClick={submit}
        type="button"
      >
        {action.isExecuting ? 'En cours…' : 'Valider'}
      </button>
      <button
        className="min-h-11 rounded-md px-3 text-sm text-muted underline md:min-h-9"
        onClick={onDone}
        type="button"
      >
        Annuler
      </button>
      {feedback && <InlineFeedback kind={feedback.kind} message={feedback.msg} />}
    </div>
  );
}

function ThresholdForm({
  productId,
  current,
  onDone,
}: {
  productId: string;
  current: number;
  onDone: () => void;
}) {
  const action = useAction(setLowStockThresholdAction);
  const [value, setValue] = useState(String(current));
  const [feedback, setFeedback] = useState<{ msg: string; kind: 'error' | 'success' } | null>(null);

  async function submit() {
    const t = Number.parseInt(value, 10);
    if (!Number.isFinite(t) || t < 0) {
      setFeedback({ msg: 'Seuil invalide (≥ 0).', kind: 'error' });
      return;
    }
    const res = await action.executeAsync({ productId, threshold: t });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Seuil mis à jour.', kind: 'success' });
      setTimeout(onDone, 600);
    } else {
      setFeedback({ msg: 'Erreur de mise à jour.', kind: 'error' });
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        className="min-h-11 w-20 rounded-md border border-border bg-canvas px-2 text-sm md:min-h-9"
        min="0"
        onChange={(e) => setValue(e.target.value)}
        type="number"
        value={value}
      />
      <button
        className="min-h-11 rounded-md px-3 text-sm font-medium text-accent underline disabled:opacity-60 md:min-h-9"
        disabled={action.isExecuting}
        onClick={submit}
        type="button"
      >
        OK
      </button>
      <button
        className="min-h-11 rounded-md px-3 text-sm text-muted underline md:min-h-9"
        onClick={onDone}
        type="button"
      >
        ✕
      </button>
      {feedback && <InlineFeedback kind={feedback.kind} message={feedback.msg} />}
    </div>
  );
}

export function StockTable({ rows, canSeeCost }: Props) {
  const [activeForm, setActiveForm] = useState<ActiveForm>(null);
  const [thresholdEdit, setThresholdEdit] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        Aucun produit actif. Ajoutez des produits dans le catalogue pour gérer le stock.
      </p>
    );
  }

  // Un bundle n'a pas de qty_on_hand propre significatif (cascade PR 1) : son
  // isLowStock/stockValue propres sont exclus des agrégats, qui n'auraient
  // aucun sens mélangés à des stocks de produits normaux.
  const lowStockCount = rows.filter((r) => !r.isBundle && r.isLowStock).length;
  const totalValue = canSeeCost
    ? rows.filter((r) => !r.isBundle).reduce((sum, r) => sum + (r.stockValue ?? 0), 0)
    : null;

  function closeForm() {
    setActiveForm(null);
  }

  function openForm(type: 'purchase' | 'adjustment' | 'return', productId: string) {
    setActiveForm({ type, productId });
    setMenuOpen(null);
  }

  return (
    <div className="space-y-4">
      {lowStockCount > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-danger/25 bg-danger-subtle p-4 text-sm font-medium text-danger">
          <span>
            {lowStockCount} produit{lowStockCount > 1 ? 's' : ''} en stock bas
          </span>
        </div>
      )}

      {canSeeCost && totalValue !== null && (
        <p className="text-sm text-muted">
          Valeur totale du stock :{' '}
          <span className="font-semibold text-text">{formatMoney(totalValue, 'XOF')}</span>
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface text-left">
              <th className="px-4 py-3 font-medium">Produit</th>
              <th className="px-4 py-3 font-medium text-right">En stock</th>
              <th className="px-4 py-3 font-medium text-right">Commandé</th>
              <th className="px-4 py-3 font-medium text-right">Disponible</th>
              <th className="px-4 py-3 font-medium text-right">Seuil alerte</th>
              {canSeeCost && <th className="px-4 py-3 font-medium text-right">Valeur</th>}
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isEditingThreshold = thresholdEdit === row.productId;
              const form =
                activeForm !== null && activeForm.productId === row.productId
                  ? activeForm.type
                  : null;

              return (
                <tr
                  key={row.productId}
                  className="border-b border-border last:border-0 hover:bg-surface/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{row.title}</span>
                      {row.sku && <span className="text-xs text-muted">{row.sku}</span>}
                      <div className="flex flex-wrap gap-1">
                        {row.isBundle && <BundleBadge />}
                        {!row.isBundle && row.isLowStock && <LowStockBadge />}
                      </div>
                    </div>
                  </td>
                  {row.isBundle ? (
                    <>
                      <td className="px-4 py-3 text-right font-mono text-muted">—</td>
                      <td className="px-4 py-3 text-right font-mono text-muted">—</td>
                      <td
                        className="px-4 py-3 text-right font-mono tabular-nums"
                        title="Disponibilité dérivée du stock de ses composants (min de stock_composant / quantité requise)"
                      >
                        {row.bundleAvailability ?? '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-muted">—</td>
                      {canSeeCost && <td className="px-4 py-3 text-right text-muted">—</td>}
                      <td className="px-4 py-3 text-xs text-muted">
                        Le stock d&apos;un bundle se gère via ses composants.
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 text-right font-mono">{row.qtyOnHand}</td>
                      <td className="px-4 py-3 text-right font-mono text-muted">
                        {row.qtyReserved}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        <span className={cn(row.isLowStock && 'text-danger font-semibold')}>
                          {row.qtyAvailable}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {isEditingThreshold ? (
                          <ThresholdForm
                            current={row.lowStockThreshold}
                            onDone={() => setThresholdEdit(null)}
                            productId={row.productId}
                          />
                        ) : (
                          <button
                            className="text-muted underline underline-offset-2 hover:text-text"
                            onClick={() => setThresholdEdit(row.productId)}
                            type="button"
                          >
                            {row.lowStockThreshold}
                          </button>
                        )}
                      </td>
                      {canSeeCost && (
                        <td className="px-4 py-3 text-right text-muted">
                          {row.stockValue !== null ? formatMoney(row.stockValue, 'XOF') : '—'}
                        </td>
                      )}
                      <td className="px-4 py-3">
                        <div className="space-y-2">
                          {!form && menuOpen !== row.productId && (
                            <button
                              className="min-h-11 rounded-md border border-border bg-canvas px-3 py-1 text-sm font-medium hover:bg-surface md:min-h-9 md:text-xs"
                              onClick={() => setMenuOpen(row.productId)}
                              type="button"
                            >
                              Modifier le stock
                            </button>
                          )}
                          {!form && menuOpen === row.productId && (
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                className="min-h-11 rounded-md border border-border bg-canvas px-3 py-1 text-sm font-medium hover:bg-surface md:min-h-9 md:text-xs"
                                onClick={() => openForm('purchase', row.productId)}
                                type="button"
                              >
                                + Entrée stock
                              </button>
                              <button
                                className="min-h-11 rounded-md border border-border bg-canvas px-3 py-1 text-sm font-medium hover:bg-surface md:min-h-9 md:text-xs"
                                onClick={() => openForm('adjustment', row.productId)}
                                type="button"
                              >
                                Ajustement
                              </button>
                              <button
                                className="min-h-11 rounded-md border border-border bg-canvas px-3 py-1 text-sm font-medium hover:bg-surface md:min-h-9 md:text-xs"
                                onClick={() => openForm('return', row.productId)}
                                type="button"
                              >
                                Retour livreur
                              </button>
                              <button
                                className="min-h-11 rounded-md px-3 text-sm text-muted underline md:min-h-9 md:text-xs"
                                onClick={() => setMenuOpen(null)}
                                type="button"
                              >
                                Annuler
                              </button>
                            </div>
                          )}
                          {form === 'purchase' && (
                            <PurchaseForm onDone={closeForm} productId={row.productId} />
                          )}
                          {form === 'adjustment' && (
                            <AdjustmentForm onDone={closeForm} productId={row.productId} />
                          )}
                          {form === 'return' && (
                            <CourierReturnForm onDone={closeForm} productId={row.productId} />
                          )}
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

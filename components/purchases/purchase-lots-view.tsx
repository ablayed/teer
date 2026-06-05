'use client';

import type { ProductCatalogItem } from '@/lib/actions/products';
import {
  type PurchaseLotData,
  type PurchaseLotLineData,
  addPurchaseLotLineAction,
  createPurchaseLotAction,
  markLotInTransitAction,
  receiveLotAction,
  removePurchaseLotLineAction,
} from '@/lib/actions/purchases';
import { formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

// ── helpers ──────────────────────────────────────────────────────────────────

type Feedback = { msg: string; kind: 'error' | 'success' };

function Alert({ msg, kind }: Feedback) {
  return (
    <p
      role="alert"
      className={cn('text-xs font-medium', kind === 'error' ? 'text-danger' : 'text-success')}
    >
      {msg}
    </p>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    ordered: { label: 'Commandé', cls: 'bg-muted text-muted-foreground' },
    in_transit: { label: 'En transit', cls: 'bg-orange-100 text-orange-800' },
    received: { label: 'Reçu', cls: 'bg-success-subtle text-success' },
  };
  const { label, cls } = map[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' };
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', cls)}>{label}</span>;
}

// ── Cost detail (per-line breakdown + reconciliation) ─────────────────────────

function CostDetail({ lines, totalFees }: { lines: PurchaseLotLineData[]; totalFees: number }) {
  const [open, setOpen] = useState(false);

  const displayLines = lines.map((l) => {
    const d =
      l.landedTotalValue != null
        ? {
            lv: l.lineValue ?? 0,
            af: l.allocatedFees ?? 0,
            ltv: l.landedTotalValue,
            luc: l.landedUnitCost ?? 0,
          }
        : l.preview
          ? {
              lv: l.preview.lineValue,
              af: l.preview.allocatedFees,
              ltv: l.preview.landedTotalValue,
              luc: l.preview.landedUnitCost,
            }
          : null;
    return { ...l, d };
  });

  const sumAllocated = displayLines.reduce((s, l) => s + (l.d?.af ?? 0), 0);

  if (displayLines.every((l) => !l.d)) return null;

  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-1 p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-sm font-medium"
      >
        <span>Détail du coût atterri</span>
        <span className="text-muted-foreground">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          {displayLines.map((l) =>
            l.d ? (
              <div key={l.id} className="text-sm">
                <p className="font-medium">
                  {l.productTitle}
                  {l.productSku ? ` (${l.productSku})` : ''} — {l.qty} pcs
                </p>
                <div className="ml-2 mt-1 space-y-0.5 text-xs text-muted-foreground font-mono tabular-nums">
                  <div className="flex justify-between">
                    <span>
                      Achat ({l.qty} × {formatMoney(l.unitPurchasePrice)})
                    </span>
                    <span>{formatMoney(l.d.lv)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Frais alloués</span>
                    <span>+ {formatMoney(l.d.af)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-0.5 font-semibold text-foreground">
                    <span>Total atterri</span>
                    <span>{formatMoney(l.d.ltv)}</span>
                  </div>
                  <div className="flex justify-between text-brand-foreground">
                    <span>Coût unitaire</span>
                    <span>{formatMoney(l.d.luc)} / u</span>
                  </div>
                </div>
              </div>
            ) : null,
          )}
          <div className="border-t border-border pt-2 text-xs">
            <p className="text-muted-foreground italic">
              Les frais partagés sont répartis au prorata de la valeur d'achat.
            </p>
            <p
              className={cn(
                'mt-1 font-medium font-mono tabular-nums',
                sumAllocated === totalFees ? 'text-success' : 'text-danger',
              )}
            >
              Vérification : Σ frais alloués = {formatMoney(sumAllocated)}{' '}
              {sumAllocated === totalFees
                ? '= Total frais ✓'
                : `≠ Total frais ${formatMoney(totalFees)} ✗`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Lot card ──────────────────────────────────────────────────────────────────

function LotCard({ lot, products }: { lot: PurchaseLotData; products: ProductCatalogItem[] }) {
  const router = useRouter();
  const transit = useAction(markLotInTransitAction);
  const receive = useAction(receiveLotAction);
  const addLine = useAction(addPurchaseLotLineAction);
  const removeLine = useAction(removePurchaseLotLineAction);

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [newLine, setNewLine] = useState({ productId: '', qty: '', unitPurchasePrice: '' });

  const isExecuting =
    transit.isExecuting || receive.isExecuting || addLine.isExecuting || removeLine.isExecuting;

  async function handleTransit() {
    const res = await transit.executeAsync({ lotId: lot.id });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Lot marqué en transit.', kind: 'success' });
      router.refresh();
    } else setFeedback({ msg: res?.data?.message ?? 'Erreur.', kind: 'error' });
  }

  async function handleReceive() {
    const res = await receive.executeAsync({ lotId: lot.id });
    if (res?.data?.ok) {
      setFeedback({ msg: 'Lot reçu. Stock mis à jour.', kind: 'success' });
      router.refresh();
    } else setFeedback({ msg: res?.data?.message ?? 'Erreur.', kind: 'error' });
  }

  async function handleAddLine() {
    const qty = Number.parseInt(newLine.qty, 10);
    const price = Number.parseInt(newLine.unitPurchasePrice, 10);
    if (!newLine.productId) {
      setFeedback({ msg: 'Sélectionnez un produit.', kind: 'error' });
      return;
    }
    if (!Number.isFinite(qty) || qty < 0) {
      setFeedback({ msg: 'Quantité invalide.', kind: 'error' });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setFeedback({ msg: 'Prix invalide.', kind: 'error' });
      return;
    }
    const res = await addLine.executeAsync({
      lotId: lot.id,
      productId: newLine.productId,
      qty,
      unitPurchasePrice: price,
    });
    if (res?.data?.ok) {
      setNewLine({ productId: '', qty: '', unitPurchasePrice: '' });
      setShowAddLine(false);
      router.refresh();
    } else setFeedback({ msg: res?.data?.message ?? 'Erreur.', kind: 'error' });
  }

  async function handleRemoveLine(lineId: string) {
    const res = await removeLine.executeAsync({ lineId, lotId: lot.id });
    if (res?.data?.ok) router.refresh();
    else setFeedback({ msg: res?.data?.message ?? 'Erreur.', kind: 'error' });
  }

  const canEdit = lot.status !== 'received';

  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-1 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold">{lot.supplierName}</p>
          {lot.reference && <p className="text-xs text-muted-foreground">{lot.reference}</p>}
        </div>
        <StatusBadge status={lot.status} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Commandé le {lot.orderedAt}</span>
        <span>
          ETA : <span className="font-medium text-foreground">{lot.eta}</span>
        </span>
        {lot.receivedAt && <span>Reçu le {lot.receivedAt}</span>}
        <span>
          Frais :{' '}
          <span className="font-mono tabular-nums font-medium text-foreground">
            {formatMoney(lot.totalFees)}
          </span>
        </span>
      </div>

      {lot.lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-surface-1 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Produit</th>
                <th className="px-3 py-2 text-right font-medium">Qté</th>
                <th className="px-3 py-2 text-right font-medium">Prix achat/u</th>
                <th className="px-3 py-2 text-right font-medium">Coût/u atterri</th>
                {canEdit && <th className="w-8" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lot.lines.map((l) => {
                const luc = l.landedUnitCost ?? l.preview?.landedUnitCost ?? null;
                return (
                  <tr key={l.id}>
                    <td className="px-3 py-2">
                      {l.productTitle}
                      {l.productSku && (
                        <span className="ml-1 text-muted-foreground">({l.productSku})</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">{l.qty}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatMoney(l.unitPurchasePrice)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {luc != null ? (
                        <span
                          className={
                            l.landedUnitCost != null
                              ? 'font-semibold text-foreground'
                              : 'text-muted-foreground italic'
                          }
                        >
                          {formatMoney(luc)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    {canEdit && (
                      <td className="px-1">
                        <button
                          type="button"
                          onClick={() => handleRemoveLine(l.id)}
                          disabled={isExecuting}
                          className="p-1 text-danger hover:text-danger/70 disabled:opacity-40"
                          aria-label="Supprimer la ligne"
                        >
                          ×
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div>
          {showAddLine ? (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <select
                value={newLine.productId}
                onChange={(e) => setNewLine((p) => ({ ...p, productId: e.target.value }))}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">Sélectionner un produit…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.sku ? ` — ${p.sku}` : ''}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <input
                  type="number"
                  min={0}
                  placeholder="Quantité"
                  value={newLine.qty}
                  onChange={(e) => setNewLine((p) => ({ ...p, qty: e.target.value }))}
                  className="w-1/2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  min={0}
                  placeholder="Prix achat/u (F CFA)"
                  value={newLine.unitPurchasePrice}
                  onChange={(e) => setNewLine((p) => ({ ...p, unitPurchasePrice: e.target.value }))}
                  className="w-1/2 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleAddLine}
                  disabled={isExecuting}
                  className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-[#111] disabled:opacity-50"
                >
                  Ajouter
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddLine(false)}
                  className="rounded-md border border-border px-4 py-2 text-sm"
                >
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddLine(true)}
              className="text-xs text-brand underline-offset-2 hover:underline"
            >
              + Ajouter un produit
            </button>
          )}
        </div>
      )}

      <CostDetail lines={lot.lines} totalFees={lot.totalFees} />

      {canEdit && (
        <div className="flex flex-wrap gap-2 pt-1">
          {lot.status === 'ordered' && (
            <button
              type="button"
              onClick={handleTransit}
              disabled={isExecuting}
              className="min-h-[44px] rounded-lg border border-border px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Marquer en transit
            </button>
          )}
          {lot.lines.length > 0 && (
            <button
              type="button"
              onClick={handleReceive}
              disabled={isExecuting}
              className="min-h-[44px] rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-[#111] disabled:opacity-50"
            >
              {receive.isExecuting ? 'Réception…' : 'Marquer reçu'}
            </button>
          )}
        </div>
      )}

      {feedback && <Alert {...feedback} />}
    </div>
  );
}

// ── Create lot form ───────────────────────────────────────────────────────────

type NewLine = { key: string; productId: string; qty: string; unitPurchasePrice: string };

function mkLine(): NewLine {
  return {
    key: Math.random().toString(36).slice(2),
    productId: '',
    qty: '',
    unitPurchasePrice: '',
  };
}

function CreateLotForm({
  products,
  onDone,
}: { products: ProductCatalogItem[]; onDone: () => void }) {
  const router = useRouter();
  const createLot = useAction(createPurchaseLotAction);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const [form, setForm] = useState({
    supplierName: '',
    reference: '',
    orderedAt: new Date().toISOString().slice(0, 10),
    shippingMode: 'normal' as 'fast' | 'normal',
    supplierPrepDays: '0',
    transportDays: '7',
    localBufferDays: '0',
    etaOverride: '',
    freightTotal: '0',
    customsTotal: '0',
    transitTotal: '0',
    localTransportTotal: '0',
  });
  const [lines, setLines] = useState<NewLine[]>([mkLine()]);

  function setF(key: keyof typeof form, value: string) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function setLine(lineKey: string, field: keyof Omit<NewLine, 'key'>, value: string) {
    setLines((prev) => prev.map((l) => (l.key === lineKey ? { ...l, [field]: value } : l)));
  }

  async function submit() {
    if (!form.supplierName.trim()) {
      setFeedback({ msg: 'Nom du fournisseur requis.', kind: 'error' });
      return;
    }
    const parsedLines = lines.map((l) => ({
      productId: l.productId,
      qty: Number.parseInt(l.qty, 10) || 0,
      unitPurchasePrice: Number.parseInt(l.unitPurchasePrice, 10) || 0,
    }));
    if (parsedLines.some((l) => !l.productId)) {
      setFeedback({ msg: 'Sélectionnez un produit pour chaque ligne.', kind: 'error' });
      return;
    }

    const res = await createLot.executeAsync({
      supplierName: form.supplierName.trim(),
      reference: form.reference.trim() || null,
      orderedAt: form.orderedAt,
      shippingMode: form.shippingMode,
      supplierPrepDays: Number.parseInt(form.supplierPrepDays, 10) || 0,
      transportDays: Number.parseInt(form.transportDays, 10) || 0,
      localBufferDays: Number.parseInt(form.localBufferDays, 10) || 0,
      etaOverride: form.etaOverride || null,
      freightTotal: Number.parseInt(form.freightTotal, 10) || 0,
      customsTotal: Number.parseInt(form.customsTotal, 10) || 0,
      transitTotal: Number.parseInt(form.transitTotal, 10) || 0,
      localTransportTotal: Number.parseInt(form.localTransportTotal, 10) || 0,
      lines: parsedLines,
    });

    if (res?.data?.ok) {
      router.refresh();
      onDone();
    } else setFeedback({ msg: res?.data?.message ?? 'Erreur création lot.', kind: 'error' });
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-1 space-y-4">
      <h3 className="font-semibold">Nouveau lot d'achat</h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="f-supplier" className="block text-xs font-medium mb-1">
            Fournisseur *
          </label>
          <input
            id="f-supplier"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.supplierName}
            onChange={(e) => setF('supplierName', e.target.value)}
            placeholder="Nom du fournisseur"
          />
        </div>
        <div>
          <label htmlFor="f-ref" className="block text-xs font-medium mb-1">
            Référence
          </label>
          <input
            id="f-ref"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.reference}
            onChange={(e) => setF('reference', e.target.value)}
            placeholder="Facture, numéro…"
          />
        </div>
        <div>
          <label htmlFor="f-ordered-at" className="block text-xs font-medium mb-1">
            Date de commande *
          </label>
          <input
            id="f-ordered-at"
            type="date"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.orderedAt}
            onChange={(e) => setF('orderedAt', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="f-shipping" className="block text-xs font-medium mb-1">
            Mode d'expédition
          </label>
          <select
            id="f-shipping"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.shippingMode}
            onChange={(e) => setF('shippingMode', e.target.value as 'fast' | 'normal')}
          >
            <option value="normal">Standard</option>
            <option value="fast">Express</option>
          </select>
        </div>
        <div>
          <label htmlFor="f-prep" className="block text-xs font-medium mb-1">
            Prép. fournisseur (j)
          </label>
          <input
            id="f-prep"
            type="number"
            min={0}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.supplierPrepDays}
            onChange={(e) => setF('supplierPrepDays', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="f-transport" className="block text-xs font-medium mb-1">
            Transport (j)
          </label>
          <input
            id="f-transport"
            type="number"
            min={0}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.transportDays}
            onChange={(e) => setF('transportDays', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="f-local" className="block text-xs font-medium mb-1">
            Transport local (j)
          </label>
          <input
            id="f-local"
            type="number"
            min={0}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.localBufferDays}
            onChange={(e) => setF('localBufferDays', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="f-eta" className="block text-xs font-medium mb-1">
            Override ETA
          </label>
          <input
            id="f-eta"
            type="date"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={form.etaOverride}
            onChange={(e) => setF('etaOverride', e.target.value)}
          />
        </div>
      </div>

      <div>
        <p className="text-xs font-medium mb-2">Frais partagés (F CFA)</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ['freightTotal', 'Fret'],
              ['customsTotal', 'Douane'],
              ['transitTotal', 'Transit'],
              ['localTransportTotal', 'Transport local'],
            ] as const
          ).map(([key, lbl]) => (
            <div key={key}>
              <label htmlFor={`f-fee-${key}`} className="block text-xs text-muted-foreground mb-1">
                {lbl}
              </label>
              <input
                id={`f-fee-${key}`}
                type="number"
                min={0}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                value={form[key]}
                onChange={(e) => setF(key, e.target.value)}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium mb-2">Produits</p>
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.key} className="flex gap-2 items-center">
              <select
                className="flex-1 rounded-md border border-border bg-surface px-2 py-2 text-sm"
                value={l.productId}
                onChange={(e) => setLine(l.key, 'productId', e.target.value)}
              >
                <option value="">Produit…</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.sku ? ` (${p.sku})` : ''}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0}
                placeholder="Qté"
                className="w-20 rounded-md border border-border bg-surface px-2 py-2 text-sm"
                value={l.qty}
                onChange={(e) => setLine(l.key, 'qty', e.target.value)}
              />
              <input
                type="number"
                min={0}
                placeholder="Prix/u"
                className="w-28 rounded-md border border-border bg-surface px-2 py-2 text-sm"
                value={l.unitPurchasePrice}
                onChange={(e) => setLine(l.key, 'unitPurchasePrice', e.target.value)}
              />
              {lines.length > 1 && (
                <button
                  type="button"
                  onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                  className="text-danger text-lg leading-none"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLines((p) => [...p, mkLine()])}
            className="text-xs text-brand underline-offset-2 hover:underline"
          >
            + Ajouter un produit
          </button>
        </div>
      </div>

      {feedback && <Alert {...feedback} />}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={createLot.isExecuting}
          className="min-h-[44px] rounded-lg bg-brand px-6 py-2 text-sm font-semibold text-[#111] disabled:opacity-50"
        >
          {createLot.isExecuting ? 'Création…' : 'Créer le lot'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="min-h-[44px] rounded-lg border border-border px-4 py-2 text-sm"
        >
          Annuler
        </button>
      </div>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function PurchaseLotsView({
  lots,
  products,
}: { lots: PurchaseLotData[]; products: ProductCatalogItem[] }) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {lots.length} lot{lots.length !== 1 ? 's' : ''}
        </p>
        {!showCreate && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="min-h-[44px] rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-[#111]"
          >
            Nouveau lot
          </button>
        )}
      </div>

      {showCreate && <CreateLotForm products={products} onDone={() => setShowCreate(false)} />}

      {lots.length === 0 && !showCreate && (
        <p className="rounded-xl border border-border bg-surface p-6 text-sm text-muted-foreground">
          Aucun lot d'achat. Cliquez sur « Nouveau lot » pour commencer.
        </p>
      )}

      {lots.map((lot) => (
        <LotCard key={lot.id} lot={lot} products={products} />
      ))}
    </div>
  );
}

'use client';

import {
  MARGIN_PCT_MISSING_LABEL,
  PurchaseLotDetailPanel,
} from '@/components/purchases/purchase-lot-detail-panel';
import { GainLoss } from '@/components/ui/gain-loss';
import { ValueAmount } from '@/components/ui/value-state';
import { type ProductCatalogItem, createProductAction } from '@/lib/actions/products';
import {
  type PurchaseLotData,
  type PurchaseLotLineData,
  addPurchaseLotLineAction,
  correctPurchaseLotTransportAction,
  createPurchaseLotAction,
  markLotInTransitAction,
  receiveLotAction,
  removePurchaseLotLineAction,
} from '@/lib/actions/purchases';
import type { PurchaseLotProfitabilitySummary } from '@/lib/finance/lot-profitability-assembly';
import { formatMoney } from '@/lib/format/fcfa';
import { formatPercentFr } from '@/lib/format/percent';
import { cn } from '@/lib/utils';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

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

function CostDetail({
  lines,
  transportTotal,
}: { lines: PurchaseLotLineData[]; transportTotal: number }) {
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
        className="flex min-h-12 w-full items-center justify-between text-sm font-medium"
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
                    <span>Achat ({l.qty} pcs)</span>
                    <span>{formatMoney(l.d.lv)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Transport</span>
                    <span>+ {formatMoney(l.d.af)}</span>
                  </div>
                  <div className="flex justify-between border-t border-border pt-0.5 font-semibold text-foreground">
                    <span>Total atterri</span>
                    <span>{formatMoney(l.d.ltv)}</span>
                  </div>
                  <div className="flex justify-between text-accent-deep">
                    <span>Coût unitaire</span>
                    <span>{formatMoney(l.d.luc)} / u</span>
                  </div>
                </div>
              </div>
            ) : null,
          )}
          <div className="border-t border-border pt-2 text-xs">
            <p className="text-muted-foreground italic">
              Le transport est réparti au prorata de la valeur d'achat.
            </p>
            <p
              className={cn(
                'mt-1 font-medium font-mono tabular-nums',
                sumAllocated === transportTotal ? 'text-success' : 'text-danger',
              )}
            >
              Vérification : Σ transport alloué = {formatMoney(sumAllocated)}{' '}
              {sumAllocated === transportTotal
                ? '= Total transport ✓'
                : `≠ Total transport ${formatMoney(transportTotal)} ✗`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Transport correction (Lot F2-bis) ───────────────────────────────────────
//
// Le transport ne se saisissait qu'à la création du lot (`CreateLotForm`),
// sans champ d'édition ensuite — or il n'est souvent pas connu à ce moment,
// c'est la raison d'être de la marge provisoire. Corrigeable ici avant COMME
// après réception (jamais restreint au statut *reçu*, contrairement à la
// méthode de répartition et au poids ci-dessous, qui restent une restriction
// distincte et non traitée par ce lot). Passe par `correct_purchase_lot_cost`
// (0145, RPC dédiée, piste d'audit) — jamais un `.update()` brut à côté.
function TransportCorrector({
  lotId,
  transportTotal,
  onCorrected,
}: {
  lotId: string;
  transportTotal: number;
  onCorrected: (newTransportTotal: number) => void;
}) {
  const correctTransport = useAction(correctPurchaseLotTransportAction);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(transportTotal));
  const [feedback, setFeedback] = useState<string | null>(null);

  function startEditing() {
    setValue(String(transportTotal));
    setFeedback(null);
    setEditing(true);
  }

  async function submit() {
    const next = Number.parseInt(value, 10);
    if (!Number.isFinite(next) || next < 0) {
      setFeedback('Montant invalide.');
      return;
    }
    const res = await correctTransport.executeAsync({ lotId, newTransportTotal: next });
    if (res?.data?.ok) {
      onCorrected(res.data.newTransportTotal);
      setEditing(false);
    } else {
      setFeedback(res?.data?.message ?? 'Erreur.');
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={startEditing}
        className="ml-1.5 min-h-6 rounded-md border border-border px-1.5 text-[11px] font-medium text-muted hover:bg-canvas hover:text-text"
      >
        Corriger
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <input
        aria-label="Corriger le transport (F CFA)"
        className="min-h-8 w-28 min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-xs tabular-nums"
        min={0}
        onChange={(e) => setValue(e.target.value)}
        type="number"
        value={value}
      />
      <button
        type="button"
        onClick={submit}
        disabled={correctTransport.isExecuting}
        className="min-h-8 rounded-md border border-border px-2 text-xs font-medium text-text hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50"
      >
        {correctTransport.isExecuting ? 'Enregistrement…' : 'Enregistrer'}
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="min-h-8 text-xs font-medium text-muted underline hover:text-text"
      >
        Annuler
      </button>
      {feedback && (
        <span className="text-xs text-danger" role="alert">
          {feedback}
        </span>
      )}
    </span>
  );
}

// ── Lot card ──────────────────────────────────────────────────────────────────

function LotCard({
  lot,
  products,
  profitability,
  autoOpenLotId,
}: {
  lot: PurchaseLotData;
  products: ProductCatalogItem[];
  profitability?: PurchaseLotProfitabilitySummary;
  autoOpenLotId?: string;
}) {
  const router = useRouter();
  const transit = useAction(markLotInTransitAction);
  const receive = useAction(receiveLotAction);
  const addLine = useAction(addPurchaseLotLineAction);
  const removeLine = useAction(removePurchaseLotLineAction);

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [newLine, setNewLine] = useState({ productId: '', qty: '', purchasePriceTotal: '' });
  const [detailOpen, setDetailOpen] = useState(false);
  // Paradigm B (valeur connue sans relecture, cf. purchase-lot-detail-panel.tsx) :
  // aucun `router.refresh()` derrière la correction de transport, jamais
  // réconcilié depuis `lot` — n'importe pas tant que la carte reste montée.
  const [transportOverride, setTransportOverride] = useState<number | null>(null);
  const effectiveTransportTotal = transportOverride ?? lot.transportTotal;
  const effectiveLot: PurchaseLotData =
    transportOverride === null ? lot : { ...lot, transportTotal: transportOverride };

  // Renvoi depuis Finances (vue arrivages, Lot F2-bis) : `?lot={id}` ouvre
  // directement la fiche rentabilité de CET arrivage, jamais un défilement
  // manuel dans la liste — Finances ne fait que lister et renvoyer, jamais
  // saisir (aucun doublon avec cette fiche).
  useEffect(() => {
    if (autoOpenLotId === lot.id && lot.status === 'received' && profitability) {
      setDetailOpen(true);
    }
  }, [autoOpenLotId, lot.id, lot.status, profitability]);

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
    const price = Number.parseInt(newLine.purchasePriceTotal, 10);
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
      purchasePriceTotal: price,
    });
    if (res?.data?.ok) {
      setNewLine({ productId: '', qty: '', purchasePriceTotal: '' });
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
        <span>
          Délai estimé :{' '}
          <span className="font-medium text-foreground">{lot.estimatedLeadTimeDays} j ouvrés</span>
        </span>
        <span>
          Transport :{' '}
          <span className="font-mono tabular-nums font-medium text-foreground">
            {formatMoney(effectiveTransportTotal)}
          </span>
          <TransportCorrector
            lotId={lot.id}
            onCorrected={setTransportOverride}
            transportTotal={effectiveTransportTotal}
          />
        </span>
        {lot.receivedAt && <span>Reçu le {lot.receivedAt}</span>}
      </div>

      {lot.status === 'received' && profitability && (
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
          {profitability.ok && profitability.allocationMethodAvailable && (
            <>
              <GainLoss
                amountMinor={profitability.totals.marginMinor}
                labels={{ gain: 'Marge', loss: 'Marge', neutral: 'Marge nulle' }}
              />
              {/* `cashCollectedMinor === 0` n'est pas « marge de 0 % » mais « rien
                  à mesurer encore » (cf. lot-profitability.ts, computeMargin.marginPct,
                  et la garde équivalente dans purchase-lot-detail-panel.tsx) — un
                  simple tiret plutôt qu'un pourcentage confiant mais faux, dès cette
                  carte liste vue avant le panneau détail. */}
              {profitability.totals.cashCollectedMinor === 0 ? (
                <ValueAmount
                  className="text-sm"
                  state={{ kind: 'missing', label: MARGIN_PCT_MISSING_LABEL }}
                />
              ) : (
                <span className="text-sm text-muted">
                  {formatPercentFr(profitability.totals.marginPct)} %
                </span>
              )}
              <span className="text-sm text-muted">
                {profitability.totals.qtySold} / {profitability.totals.qtyReceived} vendus
              </span>
              {!profitability.totals.complete && (
                <span className="text-xs text-warning">Marge provisoire</span>
              )}
            </>
          )}
          {profitability.ok && !profitability.allocationMethodAvailable && (
            <p className="text-xs text-warning">
              Répartition au poids indisponible : au moins une ligne n'a pas de poids renseigné.
            </p>
          )}
          {!profitability.ok && (
            <p className="text-xs text-muted">
              {profitability.reason === 'not_found'
                ? 'Rentabilité indisponible.'
                : 'Rentabilité indisponible pour le moment.'}
            </p>
          )}
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className="ml-auto min-h-12 rounded-md border border-border px-3 text-sm font-medium text-text hover:bg-canvas"
          >
            Voir la rentabilité
          </button>
        </div>
      )}

      {lot.lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="bg-surface-1 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Produit</th>
                <th className="px-3 py-2 text-right font-medium">Qté</th>
                <th className="px-3 py-2 text-right font-medium">Prix d'achat</th>
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
                      {formatMoney(l.purchasePriceTotal)}
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
                          className="grid size-11 place-items-center rounded-md text-danger hover:bg-danger-subtle hover:text-danger disabled:opacity-40"
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
                className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
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
                  placeholder="Qté"
                  value={newLine.qty}
                  onChange={(e) => setNewLine((p) => ({ ...p, qty: e.target.value }))}
                  className="min-h-12 w-1/3 min-w-0 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                />
                <input
                  type="number"
                  min={0}
                  placeholder="Prix d'achat total (F CFA)"
                  value={newLine.purchasePriceTotal}
                  onChange={(e) =>
                    setNewLine((p) => ({ ...p, purchasePriceTotal: e.target.value }))
                  }
                  className="min-h-12 w-2/3 min-w-0 rounded-md border border-border bg-surface px-3 py-2 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleAddLine}
                  disabled={isExecuting}
                  className="min-h-12 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-50"
                >
                  Ajouter
                </button>
                <button
                  type="button"
                  onClick={() => setShowAddLine(false)}
                  className="min-h-12 rounded-md border border-border px-4 py-2 text-sm"
                >
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddLine(true)}
              className="inline-flex min-h-12 items-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-canvas"
            >
              + Ajouter un produit
            </button>
          )}
        </div>
      )}

      <CostDetail lines={lot.lines} transportTotal={lot.transportTotal} />

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
              className="min-h-[44px] rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
            >
              {receive.isExecuting ? 'Réception…' : 'Marquer reçu'}
            </button>
          )}
        </div>
      )}

      {feedback && <Alert {...feedback} />}

      {/* Démonté quand fermé (jamais mounted+aria-hidden) : `DetailPanel` sur
          desktop garde son contenu dans le DOM même fermé (translaté hors écran)
          sans `inert` ni gestion du tabindex — un panneau monté par arrivage reçu
          laisserait un champ de poids, un bouton « Enregistrer », les 3 boutons
          de méthode et le bouton « + Ajouter une dépense publicitaire » de CHAQUE
          arrivage focusables dans l'ordre de tabulation, en violation ARIA
          (contenu focalisable sous un ancêtre aria-hidden). Même pattern que
          `products-catalog.tsx` (`{detailProduct && canManage ? <ProductDetailPanel .../> : null}`). */}
      {lot.status === 'received' && profitability && detailOpen ? (
        <PurchaseLotDetailPanel
          lot={effectiveLot}
          profitability={profitability}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ── Create lot form ───────────────────────────────────────────────────────────

type NewLine = { key: string; productId: string; qty: string; purchasePriceTotal: string };
const CREATE_PRODUCT_VALUE = '__create_product__';

function mkLine(): NewLine {
  return {
    key: Math.random().toString(36).slice(2),
    productId: '',
    qty: '',
    purchasePriceTotal: '',
  };
}

function CreateLotForm({
  products,
  onDone,
}: { products: ProductCatalogItem[]; onDone: () => void }) {
  const router = useRouter();
  const createLot = useAction(createPurchaseLotAction);
  const createProduct = useAction(createProductAction);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [productOptions, setProductOptions] = useState(products);
  const [createProductLineKey, setCreateProductLineKey] = useState<string | null>(null);
  const [productDraft, setProductDraft] = useState({ sku: '', title: '' });

  const [form, setForm] = useState({
    supplierName: '',
    reference: '',
    orderedAt: new Date().toISOString().slice(0, 10),
    estimatedLeadTimeDays: '7',
    transportTotal: '0',
  });
  const [lines, setLines] = useState<NewLine[]>([mkLine()]);

  function setF(key: keyof typeof form, value: string) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function setLine(lineKey: string, field: keyof Omit<NewLine, 'key'>, value: string) {
    setLines((prev) => prev.map((l) => (l.key === lineKey ? { ...l, [field]: value } : l)));
  }

  function selectProduct(lineKey: string, value: string) {
    if (value === CREATE_PRODUCT_VALUE) {
      setCreateProductLineKey(lineKey);
      return;
    }

    setLine(lineKey, 'productId', value);
  }

  async function handleCreateProduct() {
    if (!createProductLineKey) return;

    const res = await createProduct.executeAsync({
      sku: productDraft.sku,
      title: productDraft.title,
      unitCost: 0,
    });

    if (!res?.data?.ok) {
      setFeedback({ msg: 'La création du produit a échoué.', kind: 'error' });
      return;
    }

    const now = new Date().toISOString();
    const product: ProductCatalogItem = {
      created_at: now,
      id: res.data.product.id,
      is_active: true,
      shopify_product_id: null,
      shopify_variant_id: null,
      sku: res.data.product.sku,
      title: res.data.product.title,
      unit_cost: 0,
      updated_at: now,
    };

    setProductOptions((current) => [product, ...current]);
    setLine(createProductLineKey, 'productId', product.id);
    setProductDraft({ sku: '', title: '' });
    setCreateProductLineKey(null);
    setFeedback({ msg: 'Produit créé et sélectionné.', kind: 'success' });
  }

  async function submit() {
    if (!form.supplierName.trim()) {
      setFeedback({ msg: 'Nom du fournisseur requis.', kind: 'error' });
      return;
    }
    const parsedLines = lines.map((l) => ({
      productId: l.productId,
      qty: Number.parseInt(l.qty, 10) || 0,
      purchasePriceTotal: Number.parseInt(l.purchasePriceTotal, 10) || 0,
    }));
    if (parsedLines.some((l) => !l.productId)) {
      setFeedback({ msg: 'Sélectionnez un produit pour chaque ligne.', kind: 'error' });
      return;
    }

    const res = await createLot.executeAsync({
      supplierName: form.supplierName.trim(),
      reference: form.reference.trim() || null,
      orderedAt: form.orderedAt,
      estimatedLeadTimeDays: Number.parseInt(form.estimatedLeadTimeDays, 10) || 0,
      transportTotal: Number.parseInt(form.transportTotal, 10) || 0,
      lines: parsedLines,
    });

    if (res?.data?.ok) {
      router.refresh();
      onDone();
    } else setFeedback({ msg: res?.data?.message ?? 'Erreur création lot.', kind: 'error' });
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-1 space-y-5">
      <h3 className="text-base font-semibold">Nouveau lot d'achat</h3>

      <section className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Fournisseur
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="f-supplier" className="mb-1 block text-xs font-medium">
              Fournisseur *
            </label>
            <input
              id="f-supplier"
              className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              value={form.supplierName}
              onChange={(e) => setF('supplierName', e.target.value)}
              placeholder="Nom du fournisseur"
            />
          </div>
          <div>
            <label htmlFor="f-ref" className="mb-1 block text-xs font-medium">
              Référence
            </label>
            <input
              id="f-ref"
              className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              value={form.reference}
              onChange={(e) => setF('reference', e.target.value)}
              placeholder="Facture, numéro…"
            />
          </div>
          <div>
            <label htmlFor="f-ordered-at" className="mb-1 block text-xs font-medium">
              Date de commande *
            </label>
            <input
              id="f-ordered-at"
              type="date"
              className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              value={form.orderedAt}
              onChange={(e) => setF('orderedAt', e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="f-lead-time" className="mb-1 block text-xs font-medium">
              Délai estimé (j ouvrés)
            </label>
            <input
              id="f-lead-time"
              type="number"
              min={0}
              className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              value={form.estimatedLeadTimeDays}
              onChange={(e) => setF('estimatedLeadTimeDays', e.target.value)}
            />
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Transport
        </p>
        <div className="sm:max-w-xs">
          <label htmlFor="f-transport" className="mb-1 block text-xs text-muted-foreground">
            Frais de transport (F CFA)
          </label>
          <input
            id="f-transport"
            type="number"
            min={0}
            className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm font-mono tabular-nums"
            value={form.transportTotal}
            onChange={(e) => setF('transportTotal', e.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Réparti au prorata de la valeur d'achat de chaque ligne.
          </p>
        </div>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Produits
        </p>
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.key} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <select
                className="min-h-12 w-full min-w-0 rounded-md border border-border bg-surface px-2 py-2 text-sm sm:flex-1"
                value={l.productId}
                onChange={(e) => selectProduct(l.key, e.target.value)}
              >
                <option value="">Produit…</option>
                <option value={CREATE_PRODUCT_VALUE}>+ Créer un produit</option>
                {productOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.sku ? ` (${p.sku})` : ''}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  placeholder="Qté"
                  className="min-h-12 w-full min-w-0 rounded-md border border-border bg-surface px-2 py-2 text-sm sm:w-20"
                  value={l.qty}
                  onChange={(e) => setLine(l.key, 'qty', e.target.value)}
                />
                <input
                  type="number"
                  min={0}
                  placeholder="Prix total"
                  className="min-h-12 w-full min-w-0 rounded-md border border-border bg-surface px-2 py-2 text-sm sm:w-32"
                  value={l.purchasePriceTotal}
                  onChange={(e) => setLine(l.key, 'purchasePriceTotal', e.target.value)}
                />
                {lines.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                    className="grid size-11 shrink-0 place-items-center rounded-md text-danger text-lg leading-none hover:bg-danger-subtle"
                    aria-label="Retirer la ligne"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLines((p) => [...p, mkLine()])}
            className="inline-flex min-h-12 items-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-canvas"
          >
            + Ajouter un produit
          </button>
        </div>
        {createProductLineKey ? (
          <div className="mt-3 grid gap-3 rounded-lg border border-border bg-canvas p-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] sm:items-end">
            <label className="space-y-1">
              <span className="text-xs font-medium">Nom du produit *</span>
              <input
                className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                onChange={(e) => setProductDraft((draft) => ({ ...draft, title: e.target.value }))}
                placeholder="Ex : Sac cuir noir"
                type="text"
                value={productDraft.title}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium">SKU</span>
              <input
                className="min-h-12 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                onChange={(e) => setProductDraft((draft) => ({ ...draft, sku: e.target.value }))}
                placeholder="Ex : SAC-NOIR"
                type="text"
                value={productDraft.sku}
              />
            </label>
            <button
              className="min-h-12 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink hover:bg-accent-hover disabled:opacity-50"
              disabled={createProduct.isExecuting}
              onClick={handleCreateProduct}
              type="button"
            >
              {createProduct.isExecuting ? 'Création…' : 'Créer'}
            </button>
            <button
              className="min-h-12 rounded-md border border-border px-4 py-2 text-sm"
              onClick={() => setCreateProductLineKey(null)}
              type="button"
            >
              Annuler
            </button>
          </div>
        ) : null}
      </section>

      {feedback && <Alert {...feedback} />}

      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={createLot.isExecuting}
          className="min-h-[44px] rounded-lg bg-accent px-6 py-2 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-50"
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
  profitabilityByLotId,
  autoOpenLotId,
}: {
  lots: PurchaseLotData[];
  products: ProductCatalogItem[];
  profitabilityByLotId?: Record<string, PurchaseLotProfitabilitySummary>;
  // Renvoi depuis Finances (vue arrivages) — ouvre directement la fiche de CET
  // arrivage plutôt que de laisser le marchand le rechercher dans la liste.
  autoOpenLotId?: string;
}) {
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
            className="min-h-[44px] rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink shadow-1 hover:bg-accent-hover"
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
        <LotCard
          autoOpenLotId={autoOpenLotId}
          key={lot.id}
          lot={lot}
          products={products}
          profitability={profitabilityByLotId?.[lot.id]}
        />
      ))}
    </div>
  );
}

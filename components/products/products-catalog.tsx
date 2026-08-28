'use client';

import { ProductDetailPanel } from '@/components/products/product-detail-panel';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet';
import { ResourceRow } from '@/components/ui/resource-row';
import {
  type ProductsPageItem,
  createProductAction,
  updateProductUnitCostAction,
} from '@/lib/actions/products';
import { setLowStockThresholdAction } from '@/lib/actions/stock';
import { Info, MoreHorizontal, Store, Tag } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type ProductsCatalogProps = {
  currentRole: 'agent' | 'manager' | 'owner';
  products: ProductsPageItem[];
};

function formatMinorAmount(value: number) {
  return new Intl.NumberFormat('fr-SN', {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
  }).format(value);
}

export function ProductsCatalog({ currentRole, products }: ProductsCatalogProps) {
  const router = useRouter();
  const canManage = currentRole === 'owner' || currentRole === 'manager';
  const createProduct = useAction(createProductAction);
  const setThreshold = useAction(setLowStockThresholdAction);
  const updateUnitCost = useAction(updateProductUnitCostAction);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [sku, setSku] = useState('');
  const [unitCost, setUnitCost] = useState('0');
  const [threshold, setThresholdValue] = useState('10');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [unitCostDrafts, setUnitCostDrafts] = useState<Record<string, string>>({});
  const [mobileEditingId, setMobileEditingId] = useState<string | null>(null);
  const [detailProductId, setDetailProductId] = useState<string | null>(null);
  const detailProduct = products.find((p) => p.id === detailProductId) ?? null;

  useEffect(() => {
    const result = updateUnitCost.result.data;
    if (!result) return;
    if (result.ok) {
      setFeedback('Coût unitaire mis à jour.');
      router.refresh();
      return;
    }
    setFeedback('La mise à jour du coût a échoué.');
  }, [router, updateUnitCost.result.data]);

  async function onCreateProduct() {
    const parsedUnitCost = Number.parseInt(unitCost, 10);
    const parsedThreshold = Number.parseInt(threshold, 10);
    setFeedback(null);

    const res = await createProduct.executeAsync({
      sku,
      title,
      unitCost: Number.isFinite(parsedUnitCost) ? parsedUnitCost : Number.NaN,
    });

    if (!res?.data?.ok) {
      setFeedback('La création du produit a échoué.');
      return;
    }

    // Seuil d'alerte optionnel : posé en aval (product_stock) si non défaut.
    if (Number.isFinite(parsedThreshold) && parsedThreshold !== 10) {
      await setThreshold.executeAsync({
        productId: res.data.product.id,
        threshold: parsedThreshold,
      });
    }

    setFeedback('Produit créé.');
    setTitle('');
    setSku('');
    setUnitCost('0');
    setThresholdValue('10');
    setShowCreate(false);
    router.refresh();
  }

  function onSaveUnitCost(product: ProductsPageItem) {
    const rawValue = unitCostDrafts[product.id] ?? String(product.unit_cost ?? 0);
    const parsedUnitCost = Number.parseInt(rawValue, 10);
    setFeedback(null);
    updateUnitCost.execute({
      productId: product.id,
      unitCost: Number.isFinite(parsedUnitCost) ? parsedUnitCost : Number.NaN,
    });
  }

  return (
    <div className="space-y-6">
      {canManage ? (
        <section className="space-y-3">
          {!showCreate ? (
            <button
              className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink shadow-1 hover:bg-accent-hover"
              onClick={() => setShowCreate(true)}
              type="button"
            >
              Nouveau produit
            </button>
          ) : (
            <div className="rounded-lg border border-border bg-surface p-4 shadow-1">
              <p className="mb-3 text-sm text-muted">
                Produit créé dans Tëër (sans Shopify). Les coûts restent invisibles pour les agents.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(120px,160px)_minmax(120px,160px)]">
                <label className="space-y-2">
                  <span className="text-sm font-medium">Nom *</span>
                  <input
                    className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Ex : Sac cuir noir"
                    type="text"
                    value={title}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">SKU</span>
                  <input
                    className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
                    onChange={(event) => setSku(event.target.value)}
                    placeholder="Ex : SAC-NOIR"
                    type="text"
                    value={sku}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Coût unitaire initial</span>
                  <input
                    className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3 font-mono tabular-nums"
                    min="0"
                    onChange={(event) => setUnitCost(event.target.value)}
                    placeholder="0"
                    step="1"
                    type="number"
                    value={unitCost}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm font-medium">Seuil d'alerte</span>
                  <input
                    className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3 font-mono tabular-nums"
                    min="0"
                    onChange={(event) => setThresholdValue(event.target.value)}
                    placeholder="10"
                    step="1"
                    type="number"
                    value={threshold}
                  />
                </label>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-60"
                  disabled={createProduct.isExecuting || setThreshold.isExecuting}
                  onClick={onCreateProduct}
                  type="button"
                >
                  {createProduct.isExecuting ? 'Création…' : 'Créer le produit'}
                </button>
                <button
                  className="min-h-11 rounded-lg border border-border px-4 text-sm font-medium text-text hover:bg-canvas"
                  onClick={() => setShowCreate(false)}
                  type="button"
                >
                  Annuler
                </button>
              </div>
            </div>
          )}
          {feedback ? <p className="text-sm text-muted">{feedback}</p> : null}
        </section>
      ) : null}

      {products.length === 0 ? (
        <section className="rounded-lg border border-dashed border-border bg-surface p-6 text-sm text-muted shadow-1">
          Aucun produit dans le catalogue pour le moment.
        </section>
      ) : (
        <div className="hidden gap-3 md:grid">
          {products.map((product) => {
            const unitCostValue = unitCostDrafts[product.id] ?? String(product.unit_cost ?? 0);
            return (
              <article
                className="rounded-lg border border-border bg-surface p-4 shadow-1"
                data-testid={`product-catalog-card-${product.id}`}
                key={product.id}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex min-h-8 items-center rounded-full border border-border bg-canvas px-3 text-xs font-medium text-text">
                        {product.shopify_variant_id ? 'Shopify' : 'Manuel'}
                      </span>
                      <span className="inline-flex min-h-8 items-center rounded-full border border-border bg-canvas px-3 text-xs font-medium text-muted">
                        {product.is_active ? 'Actif' : 'Inactif'}
                      </span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-lg font-semibold text-text">{product.title}</h2>
                        {product.isBundle ? (
                          <span className="inline-flex min-h-6 items-center rounded-full bg-canvas px-2 text-xs font-medium text-muted">
                            Bundle
                          </span>
                        ) : null}
                        {canManage ? (
                          <button
                            className="inline-flex items-center gap-1 text-xs font-medium text-muted underline hover:text-text"
                            onClick={() => setDetailProductId(product.id)}
                            type="button"
                          >
                            <Info aria-hidden="true" className="size-3.5" />
                            Détails
                          </button>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-4 text-sm text-muted">
                        <span className="inline-flex items-center gap-2">
                          <Tag aria-hidden="true" className="size-4" />
                          {product.sku ?? 'SKU non renseigné'}
                        </span>
                        <span className="inline-flex items-center gap-2">
                          <Store aria-hidden="true" className="size-4" />
                          {product.shopify_variant_id
                            ? `Variant ${product.shopify_variant_id}`
                            : 'Produit créé dans Tëër'}
                        </span>
                      </div>
                    </div>
                  </div>
                  {canManage ? (
                    <div className="grid gap-2 sm:grid-cols-[minmax(140px,180px)_auto] sm:items-end">
                      <label className="space-y-2">
                        <span className="text-sm font-medium">Coût unitaire</span>
                        <input
                          className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3 font-mono tabular-nums"
                          min="0"
                          onChange={(event) =>
                            setUnitCostDrafts((current) => ({
                              ...current,
                              [product.id]: event.target.value,
                            }))
                          }
                          step="1"
                          type="number"
                          value={unitCostValue}
                        />
                      </label>
                      <button
                        className="min-h-11 rounded-lg border border-border bg-canvas px-4 text-sm font-medium text-text shadow-1 hover:bg-surface disabled:opacity-60"
                        disabled={updateUnitCost.isExecuting}
                        onClick={() => onSaveUnitCost(product)}
                        type="button"
                      >
                        {updateUnitCost.isExecuting ? 'Enregistrement…' : 'Enregistrer'}
                      </button>
                    </div>
                  ) : (
                    <div className="text-sm text-muted">Coût unitaire masqué pour ce rôle.</div>
                  )}
                </div>
                {canManage && product.unit_cost !== null ? (
                  <p className="mt-3 text-sm text-muted">
                    Valeur enregistrée : {formatMinorAmount(product.unit_cost)} XOF
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {products.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-surface md:hidden">
          {products.map((product) => (
            <ProductMobileRow
              canManage={canManage}
              editingId={mobileEditingId}
              isSaving={updateUnitCost.isExecuting}
              key={product.id}
              onOpenDetail={() => setDetailProductId(product.id)}
              onSaveUnitCost={() => onSaveUnitCost(product)}
              onToggleEdit={setMobileEditingId}
              onUnitCostChange={(value) =>
                setUnitCostDrafts((current) => ({ ...current, [product.id]: value }))
              }
              product={product}
              unitCostValue={unitCostDrafts[product.id] ?? String(product.unit_cost ?? 0)}
            />
          ))}
        </div>
      ) : null}

      {detailProduct && canManage ? (
        <ProductDetailPanel
          allProducts={products}
          currentRole={currentRole}
          key={detailProduct.id}
          onClose={() => setDetailProductId(null)}
          product={detailProduct}
        />
      ) : null}
    </div>
  );
}

// ── Ligne produit mobile (ResourceRow) ──────────────────────────────────────
// Desktop reste la carte <article> ci-dessus (hidden md:grid) : cette ligne
// ne s'affiche qu'en dessous de md (md:hidden sur le conteneur parent).
// Le coût unitaire n'est pas éditable en ligne ici (rôle rare, 1x à la
// création) : il apparaît en meta, et son édition passe par l'overflow.

function ProductMobileRow({
  canManage,
  editingId,
  isSaving,
  onOpenDetail,
  onSaveUnitCost,
  onToggleEdit,
  onUnitCostChange,
  product,
  unitCostValue,
}: {
  canManage: boolean;
  editingId: string | null;
  isSaving: boolean;
  onOpenDetail: () => void;
  onSaveUnitCost: () => void;
  onToggleEdit: (productId: string | null) => void;
  onUnitCostChange: (value: string) => void;
  product: ProductsPageItem;
  unitCostValue: string;
}) {
  const metaParts = [product.sku ?? 'SKU non renseigné'];
  if (canManage) {
    metaParts.push(`${formatMinorAmount(product.unit_cost ?? 0)} XOF`);
  }
  if (product.isBundle) {
    metaParts.push('Bundle');
  }

  const overflowItems: ActionSheetItem[] = canManage
    ? [
        {
          key: 'edit-cost',
          label: 'Modifier le coût',
          icon: <Tag className="size-4" />,
          onSelect: () => onToggleEdit(product.id),
        },
        {
          key: 'details',
          label: 'Détails',
          icon: <Info className="size-4" />,
          onSelect: onOpenDetail,
        },
      ]
    : [];

  return (
    <>
      <ResourceRow
        meta={metaParts.join(' · ')}
        overflow={
          canManage ? (
            <ActionSheet
              align="end"
              items={overflowItems}
              title={product.title}
              trigger={
                <button
                  aria-label={`Actions — ${product.title}`}
                  className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </button>
              }
            />
          ) : null
        }
        status={
          !product.is_active ? (
            <span className="rounded-full bg-canvas px-2 py-0.5 text-[11px] font-medium text-muted">
              Inactif
            </span>
          ) : null
        }
        testId={`product-catalog-row-${product.id}`}
        title={<h2 className="truncate text-base font-semibold text-text">{product.title}</h2>}
      />
      {editingId === product.id ? (
        <div className="flex items-end gap-2 border-b border-border bg-canvas px-3 py-3">
          <label className="flex-1 space-y-1">
            <span className="text-xs font-medium text-muted">Coût unitaire</span>
            <input
              className="min-h-11 w-full rounded-md border border-border bg-surface px-2 font-mono text-sm tabular-nums"
              min="0"
              onChange={(event) => onUnitCostChange(event.target.value)}
              step="1"
              type="number"
              value={unitCostValue}
            />
          </label>
          <button
            className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-60"
            disabled={isSaving}
            onClick={onSaveUnitCost}
            type="button"
          >
            {isSaving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <button
            className="min-h-11 rounded-md px-3 text-sm text-muted underline"
            onClick={() => onToggleEdit(null)}
            type="button"
          >
            Annuler
          </button>
        </div>
      ) : null}
    </>
  );
}

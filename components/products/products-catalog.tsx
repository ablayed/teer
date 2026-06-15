'use client';

import {
  type ProductCatalogItem,
  createProductAction,
  updateProductUnitCostAction,
} from '@/lib/actions/products';
import { setLowStockThresholdAction } from '@/lib/actions/stock';
import { Store, Tag } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type ProductsCatalogProps = {
  currentRole: 'agent' | 'manager' | 'owner';
  products: ProductCatalogItem[];
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

  function onSaveUnitCost(product: ProductCatalogItem) {
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
        <div className="grid gap-3">
          {products.map((product) => {
            const unitCostValue = unitCostDrafts[product.id] ?? String(product.unit_cost ?? 0);
            return (
              <article
                className="rounded-lg border border-border bg-surface p-4 shadow-1"
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
                      <h2 className="text-lg font-semibold text-text">{product.title}</h2>
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
    </div>
  );
}

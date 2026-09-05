'use client';

import { useOrdersBoard } from '@/components/orders/orders-board-context';
import { Amount } from '@/components/ui/amount';
import { createManualOrderAction } from '@/lib/actions/orders';
import { createProductAction } from '@/lib/actions/products';
import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import type { ShopFilterOption } from '@/lib/shops/shop-filter';
import { cn } from '@/lib/utils';
import { Search, Trash2 } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

const sourceOptions = [
  { value: 'manual', label: 'Manuel' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'appel', label: 'Appel' },
] as const;

type ProductOption = {
  id: string;
  sku: string | null;
  title: string;
};

type OrderLine = {
  id: string;
  productId: string;
  productSearch: string;
  quantity: string;
  unitPrice: string;
};

type LineError = {
  productId?: string;
  quantity?: string;
  unitPrice?: string;
};

type FieldErrors = Partial<
  Record<'customerName' | 'phone' | 'shop', string> & {
    lines: string;
    lineErrors: LineError[];
  }
>;

type NewOrderFormProps = {
  products: ProductOption[];
  shops: ShopFilterOption[];
};

const inputBase = 'min-h-12 w-full rounded-lg border border-border bg-canvas px-3';

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="text-xs text-danger" role="alert">
      {message}
    </p>
  );
}

function newLine(): OrderLine {
  return {
    id: crypto.randomUUID(),
    productId: '',
    productSearch: '',
    quantity: '1',
    unitPrice: '',
  };
}

export function NewOrderForm({ products, shops }: NewOrderFormProps) {
  const board = useOrdersBoard();
  const router = useRouter();
  const createOrder = useAction(createManualOrderAction);
  const createProduct = useAction(createProductAction);
  const requiresShopChoice = shops.length > 1;
  const [isOpen, setIsOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState<(typeof sourceOptions)[number]['value']>('manual');
  // Boutique de rattachement (Phase 13). Avec une seule boutique, on n'affiche
  // pas le sélecteur : le serveur rattache automatiquement.
  const [shopId, setShopId] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([newLine()]);
  const [address, setAddress] = useState('');
  const [feedback, setFeedback] = useState<{ message: string; kind: 'error' | 'success' } | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [showCreateProduct, setShowCreateProduct] = useState(false);
  const [newProductTitle, setNewProductTitle] = useState('');
  const [newProductSku, setNewProductSku] = useState('');
  const [availableProducts, setAvailableProducts] = useState(products);
  const lastCreatedProductIdRef = useRef<string | null>(null);

  useEffect(() => {
    setAvailableProducts(products);
  }, [products]);

  // Derived: only lines that have both a product and a parseable price contribute to the total.
  const computedTotal = useMemo(() => {
    return lines.reduce((sum, l) => {
      const qty = Number.parseInt(l.quantity, 10);
      const price = Number.parseFloat(l.unitPrice);
      if (!Number.isFinite(qty) || !Number.isFinite(price)) return sum;
      return sum + qty * price;
    }, 0);
  }, [lines]);

  useEffect(() => {
    const result = createOrder.result.data;
    if (!result) return;

    if (result.ok) {
      setCustomerName('');
      setPhone('');
      setSource('manual');
      setShopId('');
      setLines([newLine()]);
      setAddress('');
      setFieldErrors({});
      // Bannière de succès portée par CE composant (toujours monté), donc visible même
      // quand la liste (OrdersWorkspace) n'est pas montée (0 commande préalable). Rendue
      // hors du dialogue → persiste après sa fermeture.
      setFeedback({ message: 'Commande créée.', kind: 'success' });
      setIsOpen(false);
      // Paradigm A (PR #17) : le workspace relit la liste FRAÎCHE côté serveur et la
      // réinjecte dans son state (cf. orders-board-context). PAS de router.refresh()/
      // replace() — leur re-render RSC à travers ce composant client était racé (~20 %
      // de commandes invisibles en build prod). Fallback (workspace non monté = aucune
      // commande préalable) : refresh serveur simple, sans risque de vue filtrée périmée
      // puisqu'on est alors sur « Toutes » vide.
      const handled = board?.notifyOrderCreated(result.orderId) ?? false;
      if (!handled) {
        router.refresh();
      }
      return;
    }

    setFeedback({ message: result.message, kind: 'error' });
  }, [createOrder.result.data, board, router]);

  useEffect(() => {
    if (createOrder.result.validationErrors) {
      setFeedback({ message: 'Vérifiez les champs du formulaire.', kind: 'error' });
    }
  }, [createOrder.result.validationErrors]);

  useEffect(() => {
    const result = createProduct.result.data;
    if (!result) return;

    if (result.ok) {
      setAvailableProducts((current) => [result.product, ...current]);
      // Auto-select the new product in the line that triggered creation.
      if (lastCreatedProductIdRef.current !== null) {
        setLines((prev) =>
          prev.map((l) =>
            l.id === lastCreatedProductIdRef.current
              ? { ...l, productId: result.product.id, productSearch: result.product.title }
              : l,
          ),
        );
        lastCreatedProductIdRef.current = null;
      }
      setNewProductTitle('');
      setNewProductSku('');
      setShowCreateProduct(false);
      setFeedback({ message: 'Produit créé et sélectionné.', kind: 'success' });
      return;
    }

    setFeedback({ message: 'La création du produit a échoué.', kind: 'error' });
  }, [createProduct.result.data]);

  useEffect(() => {
    if (createProduct.result.validationErrors) {
      setFeedback({
        message: 'Le titre du produit est requis (2 caractères min.).',
        kind: 'error',
      });
    }
  }, [createProduct.result.validationErrors]);

  function updateLine(id: string, patch: Partial<Omit<OrderLine, 'id'>>) {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    // Clear line-level error when user changes the field.
    setFieldErrors((prev) => {
      if (!prev.lineErrors) return prev;
      const idx = lines.findIndex((l) => l.id === id);
      if (idx === -1) return prev;
      const updated = [...prev.lineErrors];
      updated[idx] = {};
      return { ...prev, lineErrors: updated };
    });
  }

  function addLine() {
    setLines((prev) => [...prev, newLine()]);
  }

  function removeLine(id: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.id !== id) : prev));
  }

  function filteredProducts(search: string) {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return availableProducts;
    return availableProducts.filter((p) => {
      const sku = p.sku?.toLowerCase() ?? '';
      return p.title.toLowerCase().includes(normalized) || sku.includes(normalized);
    });
  }

  function validate(): FieldErrors {
    const errors: FieldErrors = {};

    if (customerName.trim().length < 2) {
      errors.customerName = 'Le nom est requis (2 caractères min.).';
    }
    if (!phone.trim()) {
      errors.phone = 'Le téléphone est requis.';
    } else if (!normalizeSenegalPhone(phone)) {
      errors.phone = 'Numéro sénégalais invalide (ex : 77 123 45 67).';
    }

    if (requiresShopChoice && !shopId) {
      errors.shop = 'Sélectionnez une boutique.';
    }

    const lineErrors: LineError[] = lines.map((l) => {
      const err: LineError = {};
      if (!l.productId) err.productId = 'Sélectionnez un produit.';
      const qty = Number.parseInt(l.quantity, 10);
      if (!Number.isFinite(qty) || qty < 1) err.quantity = 'Min. 1.';
      const price = Number.parseFloat(l.unitPrice);
      if (!Number.isFinite(price) || price < 0) err.unitPrice = 'Prix invalide.';
      return err;
    });

    const hasLineError = lineErrors.some((e) => e.productId || e.quantity || e.unitPrice);
    if (hasLineError) errors.lineErrors = lineErrors;

    if (computedTotal <= 0) {
      errors.lines = 'Le montant total doit être supérieur à 0.';
    }

    return errors;
  }

  function hasErrors(errors: FieldErrors) {
    return (
      !!errors.customerName ||
      !!errors.phone ||
      !!errors.shop ||
      !!errors.lines ||
      !!errors.lineErrors?.some((e) => e.productId || e.quantity || e.unitPrice)
    );
  }

  function submit() {
    const errors = validate();
    if (hasErrors(errors)) {
      setFieldErrors(errors);
      setFeedback(null);
      return;
    }

    setFieldErrors({});
    setFeedback(null);
    createOrder.execute({
      customerName,
      phone,
      source,
      ...(shopId ? { shopId } : {}),
      lines: lines.map((l) => ({
        productId: l.productId,
        quantity: Number.parseInt(l.quantity, 10),
        unitPrice: Number.parseFloat(l.unitPrice),
      })),
      ...(address.trim() ? { address: address.trim() } : {}),
    });
  }

  function createInlineProduct(lineId: string) {
    lastCreatedProductIdRef.current = lineId;
    setFeedback(null);
    createProduct.execute({
      sku: newProductSku || undefined,
      title: newProductTitle,
      unitCost: 0,
    });
  }

  return (
    <div className="w-full max-w-2xl rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Nouvelle commande</p>
          <p className="text-sm text-muted">
            Création manuelle — client, lignes produit et montant.
          </p>
        </div>
        <button
          className="min-h-12 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover"
          onClick={() => setIsOpen((v) => !v)}
          type="button"
        >
          {isOpen ? 'Fermer' : 'Nouvelle commande'}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-4 space-y-4">
          {/* Client */}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-2 md:col-span-2">
              <span className="text-sm font-medium">Nom client</span>
              <input
                aria-invalid={!!fieldErrors.customerName}
                className={cn(inputBase, fieldErrors.customerName && 'border-danger')}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  if (fieldErrors.customerName)
                    setFieldErrors((p) => ({ ...p, customerName: undefined }));
                }}
                placeholder="Ex : Awa Diop"
                type="text"
                value={customerName}
              />
              <FieldError message={fieldErrors.customerName} />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-medium">Téléphone</span>
              <input
                aria-invalid={!!fieldErrors.phone}
                className={cn(inputBase, fieldErrors.phone && 'border-danger')}
                onChange={(e) => {
                  setPhone(e.target.value);
                  if (fieldErrors.phone) setFieldErrors((p) => ({ ...p, phone: undefined }));
                }}
                placeholder="+221 77 123 45 67"
                type="tel"
                value={phone}
              />
              <FieldError message={fieldErrors.phone} />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-medium">Source</span>
              <select
                className="min-h-12 w-full rounded-lg border border-border bg-canvas px-3"
                onChange={(e) =>
                  setSource(e.target.value as (typeof sourceOptions)[number]['value'])
                }
                value={source}
              >
                {sourceOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            {requiresShopChoice ? (
              <label className="space-y-2">
                <span className="text-sm font-medium">Boutique</span>
                <select
                  aria-invalid={!!fieldErrors.shop}
                  className={cn(
                    'min-h-12 w-full rounded-lg border border-border bg-canvas px-3',
                    fieldErrors.shop && 'border-danger',
                  )}
                  onChange={(e) => {
                    setShopId(e.target.value);
                    if (fieldErrors.shop) setFieldErrors((p) => ({ ...p, shop: undefined }));
                  }}
                  value={shopId}
                >
                  <option value="">Sélectionner une boutique</option>
                  {shops.map((shop) => (
                    <option key={shop.id} value={shop.id}>
                      {shop.label}
                    </option>
                  ))}
                </select>
                <FieldError message={fieldErrors.shop} />
              </label>
            ) : null}
          </div>

          {/* Lignes produit */}
          <div className="space-y-3">
            <p className="text-sm font-medium">Lignes produit</p>

            {lines.map((line, idx) => {
              const lineErr = fieldErrors.lineErrors?.[idx];
              const products = filteredProducts(line.productSearch);

              return (
                <div
                  key={line.id}
                  className="rounded-lg border border-border bg-canvas p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">Ligne {idx + 1}</span>
                    {lines.length > 1 && (
                      <button
                        aria-label="Supprimer la ligne"
                        className="text-muted hover:text-danger"
                        onClick={() => removeLine(line.id)}
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>

                  {/* Product search + select */}
                  <div className="space-y-1">
                    <div className="relative">
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
                      />
                      <input
                        className="min-h-12 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-sm md:min-h-10"
                        onChange={(e) => updateLine(line.id, { productSearch: e.target.value })}
                        placeholder="Rechercher titre ou SKU"
                        type="search"
                        value={line.productSearch}
                      />
                    </div>
                    <select
                      aria-invalid={!!lineErr?.productId}
                      className={cn(
                        'min-h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm md:min-h-10',
                        lineErr?.productId && 'border-danger',
                      )}
                      onChange={(e) => updateLine(line.id, { productId: e.target.value })}
                      value={line.productId}
                    >
                      <option value="">Sélectionner un produit</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                          {p.sku ? ` (${p.sku})` : ''}
                        </option>
                      ))}
                    </select>
                    <FieldError message={lineErr?.productId} />
                  </div>

                  {/* Quantity + unit price */}
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="text-xs text-muted">Quantité</span>
                      <input
                        aria-invalid={!!lineErr?.quantity}
                        className={cn(
                          'min-h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm md:min-h-10',
                          lineErr?.quantity && 'border-danger',
                        )}
                        min="1"
                        onChange={(e) => updateLine(line.id, { quantity: e.target.value })}
                        placeholder="1"
                        step="1"
                        type="number"
                        value={line.quantity}
                      />
                      <FieldError message={lineErr?.quantity} />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-muted">Prix unitaire (FCFA)</span>
                      <input
                        aria-invalid={!!lineErr?.unitPrice}
                        className={cn(
                          'min-h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm md:min-h-10',
                          lineErr?.unitPrice && 'border-danger',
                        )}
                        min="0"
                        onChange={(e) => updateLine(line.id, { unitPrice: e.target.value })}
                        placeholder="12500"
                        step="1"
                        type="number"
                        value={line.unitPrice}
                      />
                      <FieldError message={lineErr?.unitPrice} />
                    </label>
                  </div>
                </div>
              );
            })}

            {fieldErrors.lines && <FieldError message={fieldErrors.lines} />}

            <button
              className="min-h-12 rounded-lg border border-border bg-canvas px-4 text-sm font-medium hover:bg-surface md:min-h-10"
              onClick={addLine}
              type="button"
            >
              + Ajouter une ligne
            </button>
          </div>

          {/* Inline product creation */}
          <div>
            <button
              className="min-h-12 rounded-lg px-3 text-sm font-medium text-text underline underline-offset-4 md:min-h-10"
              onClick={() => setShowCreateProduct((v) => !v)}
              type="button"
            >
              {showCreateProduct ? 'Masquer la création de produit' : 'Créer un nouveau produit'}
            </button>
          </div>

          {showCreateProduct ? (
            <div className="grid gap-3 rounded-lg border border-border bg-canvas p-3 md:grid-cols-2">
              <label className="space-y-2">
                <span className="text-sm font-medium">Titre du produit</span>
                <input
                  className={inputBase}
                  onChange={(e) => setNewProductTitle(e.target.value)}
                  placeholder="Ex : Sac cuir noir"
                  type="text"
                  value={newProductTitle}
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">SKU (optionnel)</span>
                <input
                  className={inputBase}
                  onChange={(e) => setNewProductSku(e.target.value)}
                  placeholder="Ex : SAC-NOIR"
                  type="text"
                  value={newProductSku}
                />
              </label>
              <div className="md:col-span-2">
                <button
                  className="min-h-12 rounded-lg border border-border bg-surface px-4 text-sm font-medium shadow-1 hover:bg-canvas disabled:opacity-60"
                  disabled={createProduct.isExecuting}
                  onClick={() => createInlineProduct(lines[lines.length - 1]?.id ?? '')}
                  type="button"
                >
                  {createProduct.isExecuting ? 'Création…' : 'Créer et sélectionner'}
                </button>
              </div>
            </div>
          ) : null}

          {/* Address */}
          <label className="block space-y-2">
            <span className="text-sm font-medium">Adresse (optionnel)</span>
            <textarea
              className="min-h-24 w-full rounded-lg border border-border bg-canvas px-3 py-2"
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Quartier, repère, ville"
              value={address}
            />
          </label>

          {/* Total + submit */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm">
              <span className="text-muted">Total : </span>
              <span className="font-semibold text-text">
                {computedTotal > 0 ? <Amount amountMinor={computedTotal} /> : '—'}
              </span>
            </p>
            <button
              className="min-h-12 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
              disabled={createOrder.isExecuting}
              onClick={submit}
              type="button"
            >
              {createOrder.isExecuting ? 'Création…' : 'Créer la commande'}
            </button>
          </div>
        </div>
      ) : null}

      {feedback ? (
        <div
          className={cn(
            'mt-4 rounded-lg border p-3 text-sm font-medium',
            feedback.kind === 'error'
              ? 'border-danger/30 bg-danger-subtle text-danger'
              : 'border-success/25 bg-success-subtle text-success',
          )}
          role="alert"
        >
          {feedback.message}
        </div>
      ) : null}
    </div>
  );
}

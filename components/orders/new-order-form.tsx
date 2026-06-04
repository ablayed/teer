'use client';

import { createManualOrderAction } from '@/lib/actions/orders';
import { createProductAction } from '@/lib/actions/products';
import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import { cn } from '@/lib/utils';
import { Search } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

const sourceOptions = [
  { value: 'manual', label: 'Manuel' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'facebook', label: 'Facebook' },
] as const;

type ProductOption = {
  id: string;
  sku: string | null;
  title: string;
};

type NewOrderFormProps = {
  products: ProductOption[];
};

type FieldErrors = Partial<
  Record<'customerName' | 'phone' | 'productId' | 'quantity' | 'totalAmount', string>
>;

const inputBase = 'min-h-11 w-full rounded-lg border border-border bg-canvas px-3';

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p className="text-xs text-danger" role="alert">
      {message}
    </p>
  );
}

export function NewOrderForm({ products }: NewOrderFormProps) {
  const router = useRouter();
  const createOrder = useAction(createManualOrderAction);
  const createProduct = useAction(createProductAction);
  const [isOpen, setIsOpen] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [source, setSource] = useState<(typeof sourceOptions)[number]['value']>('manual');
  const [productSearch, setProductSearch] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [totalAmount, setTotalAmount] = useState('');
  const [address, setAddress] = useState('');
  const [feedback, setFeedback] = useState<{ message: string; kind: 'error' | 'success' } | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [showCreateProduct, setShowCreateProduct] = useState(false);
  const [newProductTitle, setNewProductTitle] = useState('');
  const [newProductSku, setNewProductSku] = useState('');
  const [availableProducts, setAvailableProducts] = useState(products);

  useEffect(() => {
    setAvailableProducts(products);
  }, [products]);

  const filteredProducts = useMemo(() => {
    const normalized = productSearch.trim().toLowerCase();
    if (!normalized) return availableProducts;
    return availableProducts.filter((product) => {
      const sku = product.sku?.toLowerCase() ?? '';
      return product.title.toLowerCase().includes(normalized) || sku.includes(normalized);
    });
  }, [availableProducts, productSearch]);

  useEffect(() => {
    const result = createOrder.result.data;
    if (!result) return;

    if (result.ok) {
      setFeedback({ message: 'Commande créée.', kind: 'success' });
      setCustomerName('');
      setPhone('');
      setSource('manual');
      setProductSearch('');
      setSelectedProductId('');
      setQuantity('1');
      setTotalAmount('');
      setAddress('');
      setFieldErrors({});
      setIsOpen(false);
      router.replace('/commandes');
      router.refresh();
      return;
    }

    setFeedback({ message: result.message, kind: 'error' });
  }, [createOrder.result.data, router]);

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
      setSelectedProductId(result.product.id);
      setProductSearch(result.product.title);
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

  function clearFieldError(field: keyof FieldErrors) {
    if (fieldErrors[field]) {
      setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
    }
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
    if (!selectedProductId) {
      errors.productId = 'Sélectionnez un produit.';
    }
    const parsedQty = Number.parseInt(quantity, 10);
    if (!Number.isFinite(parsedQty) || parsedQty < 1) {
      errors.quantity = 'La quantité est requise (min. 1).';
    }
    const parsedAmount = Number.parseFloat(totalAmount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      errors.totalAmount = 'Le prix est requis.';
    }

    return errors;
  }

  function submit() {
    const errors = validate();

    if (Object.keys(errors).length > 0) {
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
      productId: selectedProductId,
      quantity: Number.parseInt(quantity, 10),
      totalAmount: Number.parseFloat(totalAmount),
      ...(address.trim() ? { address: address.trim() } : {}),
    });
  }

  function createInlineProduct() {
    setFeedback(null);
    createProduct.execute({
      sku: newProductSku,
      title: newProductTitle,
      unitCost: 0,
    });
  }

  return (
    <div className="w-full max-w-xl rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Nouvelle commande</p>
          <p className="text-sm text-muted">
            Création manuelle avec client, produit catalogue, quantité et montant.
          </p>
        </div>
        <button
          className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover"
          onClick={() => setIsOpen((value) => !value)}
          type="button"
        >
          {isOpen ? 'Fermer' : 'Nouvelle commande'}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium">Nom client</span>
            <input
              aria-invalid={!!fieldErrors.customerName}
              className={cn(inputBase, fieldErrors.customerName && 'border-danger')}
              onChange={(event) => {
                setCustomerName(event.target.value);
                clearFieldError('customerName');
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
              onChange={(event) => {
                setPhone(event.target.value);
                clearFieldError('phone');
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
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) =>
                setSource(event.target.value as (typeof sourceOptions)[number]['value'])
              }
              value={source}
            >
              {sourceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium">Recherche produit</span>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
              />
              <input
                className="min-h-11 w-full rounded-lg border border-border bg-canvas pl-10 pr-3"
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Titre ou SKU"
                type="search"
                value={productSearch}
              />
            </div>
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium">Produit</span>
            <select
              aria-invalid={!!fieldErrors.productId}
              className={cn(
                'min-h-11 w-full rounded-lg border border-border bg-canvas px-3',
                fieldErrors.productId && 'border-danger',
              )}
              onChange={(event) => {
                setSelectedProductId(event.target.value);
                clearFieldError('productId');
              }}
              value={selectedProductId}
            >
              <option value="">Sélectionner un produit</option>
              {filteredProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                  {product.sku ? ` (${product.sku})` : ''}
                </option>
              ))}
            </select>
            <FieldError message={fieldErrors.productId} />
          </label>

          <div className="md:col-span-2">
            <button
              className="min-h-11 text-sm font-medium text-text underline underline-offset-4"
              onClick={() => setShowCreateProduct((value) => !value)}
              type="button"
            >
              {showCreateProduct ? 'Masquer la création de produit' : 'Créer un nouveau produit'}
            </button>
          </div>

          {showCreateProduct ? (
            <>
              <label className="space-y-2">
                <span className="text-sm font-medium">Titre du produit</span>
                <input
                  className={inputBase}
                  onChange={(event) => setNewProductTitle(event.target.value)}
                  placeholder="Ex : Sac cuir noir"
                  type="text"
                  value={newProductTitle}
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">SKU (optionnel)</span>
                <input
                  className={inputBase}
                  onChange={(event) => setNewProductSku(event.target.value)}
                  placeholder="Ex : SAC-NOIR"
                  type="text"
                  value={newProductSku}
                />
              </label>
              <div className="md:col-span-2">
                <button
                  className="min-h-11 rounded-lg border border-border bg-canvas px-4 text-sm font-medium text-text shadow-1 hover:bg-surface disabled:opacity-60"
                  disabled={createProduct.isExecuting}
                  onClick={createInlineProduct}
                  type="button"
                >
                  {createProduct.isExecuting ? 'Création…' : 'Créer et sélectionner'}
                </button>
              </div>
            </>
          ) : null}

          <label className="space-y-2">
            <span className="text-sm font-medium">Quantité</span>
            <input
              aria-invalid={!!fieldErrors.quantity}
              className={cn(inputBase, fieldErrors.quantity && 'border-danger')}
              min="1"
              onChange={(event) => {
                setQuantity(event.target.value);
                clearFieldError('quantity');
              }}
              placeholder="1"
              step="1"
              type="number"
              value={quantity}
            />
            <FieldError message={fieldErrors.quantity} />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Montant total</span>
            <input
              aria-invalid={!!fieldErrors.totalAmount}
              className={cn(inputBase, fieldErrors.totalAmount && 'border-danger')}
              min="1"
              onChange={(event) => {
                setTotalAmount(event.target.value);
                clearFieldError('totalAmount');
              }}
              placeholder="12500"
              step="0.01"
              type="number"
              value={totalAmount}
            />
            <FieldError message={fieldErrors.totalAmount} />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium">Adresse (optionnel)</span>
            <textarea
              className="min-h-24 w-full rounded-lg border border-border bg-canvas px-3 py-2"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Quartier, repère, ville"
              value={address}
            />
          </label>

          <div className="space-y-3 md:col-span-2">
            <button
              className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60"
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

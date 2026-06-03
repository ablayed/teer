'use client';

import { createManualOrderAction } from '@/lib/actions/orders';
import { createProductAction } from '@/lib/actions/products';
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
  const [feedback, setFeedback] = useState<string | null>(null);
  const [showCreateProduct, setShowCreateProduct] = useState(false);
  const [newProductTitle, setNewProductTitle] = useState('');
  const [newProductSku, setNewProductSku] = useState('');
  const [availableProducts, setAvailableProducts] = useState(products);

  useEffect(() => {
    setAvailableProducts(products);
  }, [products]);

  const filteredProducts = useMemo(() => {
    const normalized = productSearch.trim().toLowerCase();

    if (!normalized) {
      return availableProducts;
    }

    return availableProducts.filter((product) => {
      const sku = product.sku?.toLowerCase() ?? '';
      return product.title.toLowerCase().includes(normalized) || sku.includes(normalized);
    });
  }, [availableProducts, productSearch]);

  useEffect(() => {
    const result = createOrder.result.data;

    if (!result) {
      return;
    }

    if (result.ok) {
      setFeedback('Commande creee.');
      setCustomerName('');
      setPhone('');
      setSource('manual');
      setProductSearch('');
      setSelectedProductId('');
      setQuantity('1');
      setTotalAmount('');
      setAddress('');
      setIsOpen(false);
      router.replace('/commandes');
      router.refresh();
      return;
    }

    setFeedback(result.message);
  }, [createOrder.result.data, router]);

  useEffect(() => {
    const result = createProduct.result.data;

    if (!result) {
      return;
    }

    if (result.ok) {
      setAvailableProducts((current) => [result.product, ...current]);
      setSelectedProductId(result.product.id);
      setProductSearch(result.product.title);
      setNewProductTitle('');
      setNewProductSku('');
      setShowCreateProduct(false);
      setFeedback('Produit cree et selectionne.');
      return;
    }

    setFeedback('La creation du produit a echoue.');
  }, [createProduct.result.data]);

  function submit() {
    const parsedAmount = Number.parseFloat(totalAmount);
    const parsedQuantity = Number.parseInt(quantity, 10);

    if (!selectedProductId) {
      setFeedback('Selectionnez un produit.');
      return;
    }

    setFeedback(null);
    createOrder.execute({
      customerName,
      phone,
      source,
      productId: selectedProductId,
      quantity: Number.isFinite(parsedQuantity) ? parsedQuantity : Number.NaN,
      totalAmount: Number.isFinite(parsedAmount) ? parsedAmount : Number.NaN,
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
            Creation manuelle avec client, produit catalogue, quantite et montant.
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
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) => setCustomerName(event.target.value)}
              placeholder="Ex : Awa Diop"
              type="text"
              value={customerName}
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Telephone</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+221 77 123 45 67"
              type="tel"
              value={phone}
            />
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
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              onChange={(event) => setSelectedProductId(event.target.value)}
              value={selectedProductId}
            >
              <option value="">Selectionner un produit</option>
              {filteredProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.title}
                  {product.sku ? ` (${product.sku})` : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="md:col-span-2">
            <button
              className="min-h-11 text-sm font-medium text-text underline underline-offset-4"
              onClick={() => setShowCreateProduct((value) => !value)}
              type="button"
            >
              {showCreateProduct ? 'Masquer la creation de produit' : 'Creer un nouveau produit'}
            </button>
          </div>

          {showCreateProduct ? (
            <>
              <label className="space-y-2">
                <span className="text-sm font-medium">Titre du produit</span>
                <input
                  className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
                  onChange={(event) => setNewProductTitle(event.target.value)}
                  placeholder="Ex : Sac cuir noir"
                  type="text"
                  value={newProductTitle}
                />
              </label>
              <label className="space-y-2">
                <span className="text-sm font-medium">SKU (optionnel)</span>
                <input
                  className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
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
                  {createProduct.isExecuting ? 'Creation…' : 'Creer et selectionner'}
                </button>
              </div>
            </>
          ) : null}

          <label className="space-y-2">
            <span className="text-sm font-medium">Quantite</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              min="1"
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="1"
              step="1"
              type="number"
              value={quantity}
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium">Montant total</span>
            <input
              className="min-h-11 w-full rounded-lg border border-border bg-canvas px-3"
              min="0"
              onChange={(event) => setTotalAmount(event.target.value)}
              placeholder="12500"
              step="0.01"
              type="number"
              value={totalAmount}
            />
          </label>

          <label className="space-y-2 md:col-span-2">
            <span className="text-sm font-medium">Adresse (optionnel)</span>
            <textarea
              className="min-h-24 w-full rounded-lg border border-border bg-canvas px-3 py-2"
              onChange={(event) => setAddress(event.target.value)}
              placeholder="Quartier, repere, ville"
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
              {createOrder.isExecuting ? 'Creation…' : 'Creer la commande'}
            </button>
          </div>
        </div>
      ) : null}
      {feedback ? <p className="mt-4 text-sm text-muted">{feedback}</p> : null}
    </div>
  );
}

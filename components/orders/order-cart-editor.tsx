'use client';

import { getOrderCartEditorDataAction, replaceOrderCartAction } from '@/lib/actions/orders';
import { formatMoney } from '@/lib/format/fcfa';
import { calculateCartTotal } from '@/lib/orders/cart-editing';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type Product = { id: string; sku: string | null; title: string };
type Line = {
  id: string;
  productId: string;
  productLabel: string;
  quantity: string;
  search: string;
  unitPrice: string;
  warning: string | null;
};

function newLine(): Line {
  return {
    id: crypto.randomUUID(),
    productId: '',
    productLabel: '',
    quantity: '1',
    search: '',
    unitPrice: '',
    warning: null,
  };
}

export function OrderCartEditor({ currency, orderId }: { currency: string; orderId: string }) {
  const router = useRouter();
  const load = useAction(getOrderCartEditorDataAction);
  const save = useAction(replaceOrderCartAction);
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (open) load.execute({ orderId });
  }, [load.execute, open, orderId]);

  useEffect(() => {
    const result = load.result.data;
    if (!result) return;
    if (!result.ok) {
      setMessage('Le panier ne peut plus être modifié.');
      return;
    }
    setProducts(result.products);
    setLines(
      result.lines.map((line) => ({
        id: crypto.randomUUID(),
        productId: line.productId ?? '',
        productLabel: line.productLabel,
        quantity: String(line.quantity),
        search: line.productLabel,
        unitPrice: line.unitPrice === null ? '' : String(line.unitPrice),
        warning: line.unresolvedReason,
      })),
    );
  }, [load.result.data]);

  useEffect(() => {
    const result = save.result.data;
    if (!result) return;
    if (result.ok) {
      setOpen(false);
      setMessage('Panier mis à jour.');
      router.refresh();
      return;
    }
    setMessage('La mise à jour du panier a échoué. Vérifiez les lignes puis réessayez.');
  }, [router, save.result.data]);

  const total = useMemo(
    () =>
      calculateCartTotal(
        lines
          .map((line) => ({ quantity: Number(line.quantity), unitPrice: Number(line.unitPrice) }))
          .filter((line) => Number.isFinite(line.quantity) && Number.isFinite(line.unitPrice)),
      ),
    [lines],
  );
  const valid =
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.productId &&
        Number.isInteger(Number(line.quantity)) &&
        Number(line.quantity) >= 1 &&
        Number(line.quantity) <= 999 &&
        Number.isFinite(Number(line.unitPrice)) &&
        Number(line.unitPrice) >= 0,
    );

  function patchLine(id: string, patch: Partial<Line>) {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function selectProduct(id: string, productId: string) {
    const product = products.find((item) => item.id === productId);
    patchLine(id, {
      productId,
      productLabel: product?.title ?? '',
      search: product?.title ?? '',
      warning: null,
    });
  }

  function submit() {
    if (!valid) {
      setMessage('Chaque ligne doit avoir un produit actif, une quantité valide et un prix.');
      return;
    }
    setMessage(null);
    save.execute({
      orderId,
      lines: lines.map((line) => ({
        productId: line.productId,
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice),
      })),
    });
  }

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium">Panier</p>
          <p className="text-sm text-muted">Produits, quantités et prix avant assignation.</p>
        </div>
        <button
          className="min-h-10 rounded-lg border border-border px-3 text-sm font-medium hover:bg-canvas"
          onClick={() => setOpen((value) => !value)}
          type="button"
        >
          {open ? 'Fermer' : 'Modifier panier'}
        </button>
      </div>
      {message ? <output className="mt-3 text-sm text-muted">{message}</output> : null}
      {open ? (
        <div className="mt-4 space-y-4">
          {load.isExecuting ? <p className="text-sm text-muted">Chargement du panier…</p> : null}
          {lines.map((line) => {
            const query = line.search.trim().toLowerCase();
            const matches = products.filter(
              (product) =>
                !query ||
                product.title.toLowerCase().includes(query) ||
                product.sku?.toLowerCase().includes(query),
            );
            return (
              <div className="space-y-2 rounded-lg border border-border p-3" key={line.id}>
                {line.warning ? (
                  <p className="text-sm text-warning" role="alert">
                    {line.warning}
                  </p>
                ) : null}
                <label className="block text-sm font-medium">
                  Produit
                  <span className="relative mt-1 block">
                    <Search
                      aria-hidden="true"
                      className="absolute left-3 top-3 size-4 text-muted"
                    />
                    <input
                      className="min-h-10 w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3"
                      onChange={(event) => patchLine(line.id, { search: event.target.value })}
                      value={line.search}
                    />
                  </span>
                </label>
                <select
                  aria-label="Produit sélectionné"
                  className="min-h-10 w-full rounded-lg border border-border bg-canvas px-3"
                  onChange={(event) => selectProduct(line.id, event.target.value)}
                  value={line.productId}
                >
                  <option value="">Sélectionnez un produit</option>
                  {matches.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.title}
                      {product.sku ? ` (${product.sku})` : ''}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <label className="text-sm font-medium">
                    Quantité
                    <input
                      className="mt-1 min-h-10 w-full rounded-lg border border-border bg-canvas px-3"
                      min="1"
                      onChange={(event) => patchLine(line.id, { quantity: event.target.value })}
                      type="number"
                      value={line.quantity}
                    />
                  </label>
                  <label className="text-sm font-medium">
                    Prix unitaire
                    <input
                      className="mt-1 min-h-10 w-full rounded-lg border border-border bg-canvas px-3"
                      min="0"
                      onChange={(event) => patchLine(line.id, { unitPrice: event.target.value })}
                      type="number"
                      value={line.unitPrice}
                    />
                  </label>
                  <button
                    aria-label="Supprimer la ligne"
                    className="mt-6 inline-flex size-10 items-center justify-center rounded-lg border border-border hover:bg-canvas"
                    disabled={lines.length === 1}
                    onClick={() =>
                      setLines((current) =>
                        current.length > 1
                          ? current.filter((item) => item.id !== line.id)
                          : current,
                      )
                    }
                    type="button"
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </div>
            );
          })}
          <button
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-canvas"
            onClick={() => setLines((current) => [...current, newLine()])}
            type="button"
          >
            <Plus aria-hidden="true" className="size-4" />
            Ajouter un produit
          </button>
          <div className="flex items-center justify-between border-t border-border pt-3">
            <p className="font-medium">Total</p>
            <p className="font-mono font-semibold">{formatMoney(total, currency)}</p>
          </div>
          <button
            className="min-h-10 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] disabled:opacity-50"
            disabled={!valid || save.isExecuting}
            onClick={submit}
            type="button"
          >
            Enregistrer le panier
          </button>
        </div>
      ) : null}
    </section>
  );
}

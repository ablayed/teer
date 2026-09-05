'use client';

import { setDriverStockAction } from '@/lib/actions/drivers';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type ProductOption = { id: string; title: string; sku: string | null };

type StockRow = {
  productId: string;
  title: string;
  sku: string | null;
  physicalQty: number;
  availableQty: number;
};

type Props = {
  driverId: string;
  products: ProductOption[];
  physicalRows: { productId: string; title: string; sku: string | null; qtyOnHand: number }[];
  availableRows: { productId: string; title: string; sku: string | null; qtyAvailable: number }[];
};

type Feedback = { msg: string; kind: 'error' | 'success' } | null;

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

function SetStockForm({
  driverId,
  productId,
  productTitle,
  currentQty,
  onDone,
}: {
  driverId: string;
  productId: string;
  productTitle: string;
  currentQty: number;
  onDone: () => void;
}) {
  const t = useTranslations('livreurs.stock');
  const router = useRouter();
  const action = useAction(setDriverStockAction);
  const [value, setValue] = useState(String(currentQty));
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit() {
    const newQty = Number.parseInt(value, 10);
    if (!Number.isFinite(newQty)) {
      setFeedback({ msg: 'Quantité invalide.', kind: 'error' });
      return;
    }

    // Un newQty négatif n'est PAS rejeté ici : il doit atteindre le serveur
    // pour déclencher le blocage "retrait excédentaire" avec un message détaillé
    // (montant exact en trop), pas une validation générique côté client.
    const res = await action.executeAsync({
      driverId,
      productId,
      newQty,
      clientRequestId: crypto.randomUUID(),
    });

    const data = res?.data;
    if (data?.ok) {
      if (data.delta === 0) {
        setFeedback({ msg: t('noChange'), kind: 'success' });
      } else {
        setFeedback({ msg: t('success'), kind: 'success' });
        router.refresh();
      }
      setTimeout(onDone, 800);
      return;
    }

    if (data && !data.ok && 'shortage' in data && data.shortage) {
      const message =
        data.shortage.reason === 'central'
          ? t('shortageCentral.item', { product: productTitle, qty: data.shortage.missingQty })
          : t('shortagePhysical.item', {
              product: productTitle,
              current: data.shortage.currentQty,
              qty: data.shortage.excessQty,
            });
      setFeedback({ msg: message, kind: 'error' });
      return;
    }

    setFeedback({
      msg: (data && !data.ok && data.message) || "Erreur lors de l'enregistrement.",
      kind: 'error',
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1">
        <span className="text-xs text-muted">{t('newQtyLabel')}</span>
        <input
          className="min-h-12 w-24 rounded-md border border-border bg-canvas px-2 text-sm md:min-h-9"
          onChange={(e) => setValue(e.target.value)}
          type="number"
          value={value}
        />
      </label>
      <button
        className="min-h-12 rounded-md bg-accent px-3 text-sm font-semibold text-[#111] hover:bg-accent-hover disabled:opacity-60 md:min-h-9"
        disabled={action.isExecuting}
        onClick={submit}
        type="button"
      >
        {action.isExecuting ? 'En cours…' : t('submit')}
      </button>
      <button
        className="min-h-12 rounded-md px-3 text-sm text-muted underline md:min-h-9"
        onClick={onDone}
        type="button"
      >
        {t('cancel')}
      </button>
      {feedback && <InlineFeedback kind={feedback.kind} message={feedback.msg} />}
    </div>
  );
}

export function DriverStockTable({ driverId, products, physicalRows, availableRows }: Props) {
  const t = useTranslations('livreurs.stock');
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  const [addingProductId, setAddingProductId] = useState('');

  const physicalByProduct = new Map(physicalRows.map((r) => [r.productId, r.qtyOnHand]));
  const availableByProduct = new Map(availableRows.map((r) => [r.productId, r.qtyAvailable]));

  const rowProductIds = new Set([
    ...physicalRows.map((r) => r.productId),
    ...availableRows.map((r) => r.productId),
  ]);

  const titleByProduct = new Map<string, { title: string; sku: string | null }>();
  for (const r of physicalRows) titleByProduct.set(r.productId, { title: r.title, sku: r.sku });
  for (const r of availableRows) {
    if (!titleByProduct.has(r.productId)) {
      titleByProduct.set(r.productId, { title: r.title, sku: r.sku });
    }
  }

  const rows: StockRow[] = [...rowProductIds]
    .map((productId) => {
      const meta = titleByProduct.get(productId);
      return {
        productId,
        title: meta?.title ?? 'Produit inconnu',
        sku: meta?.sku ?? null,
        physicalQty: physicalByProduct.get(productId) ?? 0,
        availableQty: availableByProduct.get(productId) ?? 0,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  const addableProducts = products.filter((p) => !rowProductIds.has(p.id));

  function closeForm() {
    setActiveProductId(null);
    setAddingProductId('');
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{t('empty')}</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface text-left">
                  <th className="px-4 py-3 font-medium">{t('productColumn')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('physicalColumn')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('availableColumn')}</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr className="border-b border-border last:border-0" key={row.productId}>
                    <td className="px-4 py-3">
                      <span className="font-medium">{row.title}</span>
                      {row.sku && <span className="ml-2 text-xs text-muted">{row.sku}</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {row.physicalQty}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {row.availableQty}
                    </td>
                    <td className="px-4 py-3">
                      {activeProductId === row.productId ? (
                        <SetStockForm
                          currentQty={row.physicalQty}
                          driverId={driverId}
                          onDone={closeForm}
                          productId={row.productId}
                          productTitle={row.title}
                        />
                      ) : (
                        <button
                          className="min-h-12 rounded-md border border-border bg-canvas px-3 py-1 text-sm font-medium hover:bg-surface md:min-h-9 md:text-xs"
                          onClick={() => setActiveProductId(row.productId)}
                          type="button"
                        >
                          {t('action')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="space-y-2 overflow-hidden rounded-lg border border-border bg-surface p-3 md:hidden">
            {rows.map((row) => (
              <div
                className="space-y-2 border-b border-border pb-3 last:border-0"
                key={row.productId}
              >
                <div>
                  <span className="font-medium">{row.title}</span>
                  {row.sku && <span className="ml-2 text-xs text-muted">{row.sku}</span>}
                </div>
                <div className="flex gap-4 text-sm">
                  <span>
                    {t('physicalColumn')} :{' '}
                    <span className="font-mono tabular-nums">{row.physicalQty}</span>
                  </span>
                  <span>
                    {t('availableColumn')} :{' '}
                    <span className="font-mono tabular-nums">{row.availableQty}</span>
                  </span>
                </div>
                {activeProductId === row.productId ? (
                  <SetStockForm
                    currentQty={row.physicalQty}
                    driverId={driverId}
                    onDone={closeForm}
                    productId={row.productId}
                    productTitle={row.title}
                  />
                ) : (
                  <button
                    className="min-h-12 rounded-md border border-border bg-canvas px-3 py-1 text-sm font-medium hover:bg-surface"
                    onClick={() => setActiveProductId(row.productId)}
                    type="button"
                  >
                    {t('action')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {addableProducts.length > 0 && (
        <div className="rounded-lg border border-border bg-surface p-3">
          {addingProductId ? (
            <SetStockForm
              currentQty={0}
              driverId={driverId}
              onDone={closeForm}
              productId={addingProductId}
              productTitle={
                addableProducts.find((p) => p.id === addingProductId)?.title ?? 'Produit'
              }
            />
          ) : (
            <label className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{t('addProduct')}</span>
              <select
                className="min-h-12 w-56 rounded-md border border-border bg-canvas px-2 text-sm md:min-h-9"
                onChange={(e) => setAddingProductId(e.target.value)}
                value={addingProductId}
              >
                <option value="">{t('chooseProduct')}</option>
                {addableProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                    {p.sku ? ` (${p.sku})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

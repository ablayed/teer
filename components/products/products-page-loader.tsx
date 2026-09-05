'use client';

import { ProductSearchBar } from '@/components/products/product-search-bar';
import { ProductsCatalog } from '@/components/products/products-catalog';
import { StockTable } from '@/components/stock/stock-table';
import { type ProductsPageItem, loadMoreProductsAction } from '@/lib/actions/products';
import type { StockPageRow } from '@/lib/actions/stock';
import type { StockCatalogSummary } from '@/lib/stock/stock-catalog-facts';
import type { TeamRole } from '@/lib/team/permissions';
import { useEffect, useState, useTransition } from 'react';

type Props = {
  view: 'catalogue' | 'stock';
  initialItems: ProductsPageItem[];
  initialHasMore: boolean;
  initialNextOffset: number;
  canSeeCost: boolean;
  currentRole: TeamRole;
  searchQuery: string;
  storeId: string;
  stockSummary: StockCatalogSummary | null;
  lowStockOnly: boolean;
};

function toStockRow(item: ProductsPageItem): StockPageRow {
  return {
    productId: item.id,
    title: item.title,
    sku: item.sku,
    qtyOnHand: item.qtyOnHand,
    qtyReserved: item.qtyReserved,
    qtyAvailable: item.qtyAvailable,
    lowStockThreshold: item.lowStockThreshold,
    isLowStock: item.isLowStock,
    unitCost: item.stockUnitCost,
    stockValue: item.stockValue,
    isBundle: item.isBundle,
    bundleAvailability: item.bundleAvailability,
  };
}

export function ProductsPageLoader({
  view,
  initialItems,
  initialHasMore,
  initialNextOffset,
  canSeeCost,
  currentRole,
  searchQuery,
  storeId: activeStoreId,
  stockSummary,
  lowStockOnly,
}: Props) {
  const [items, setItems] = useState(initialItems);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [nextOffset, setNextOffset] = useState(initialNextOffset);
  const [isPending, startTransition] = useTransition();

  // Sync after router.refresh() triggered by create/update actions in child components
  useEffect(() => {
    setItems(initialItems);
    setHasMore(initialHasMore);
    setNextOffset(initialNextOffset);
  }, [initialItems, initialHasMore, initialNextOffset]);

  function handleLoadMore() {
    startTransition(async () => {
      const result = await loadMoreProductsAction({
        q: searchQuery || undefined,
        offset: nextOffset,
        shopId: activeStoreId,
        // "Voir plus" doit conserver le même périmètre que le chargement
        // initial (onglet Stock : actifs seulement, éventuellement filtré sur
        // le stock bas) — sinon la page mélangerait deux populations au fil
        // du défilement.
        activeOnly: view === 'stock',
        lowStockOnly: view === 'stock' ? lowStockOnly : undefined,
      });
      const data = result?.data;
      if (data?.ok) {
        setItems((prev) => [...prev, ...data.items]);
        setHasMore(data.hasMore);
        setNextOffset(data.nextOffset);
      }
    });
  }

  return (
    <div className="space-y-8">
      <ProductSearchBar
        initialQuery={searchQuery}
        storeId={activeStoreId}
        tab={view === 'stock' ? 'stock' : undefined}
      />

      {view === 'catalogue' ? (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Catalogue</h2>
          <ProductsCatalog currentRole={currentRole} products={items} />
        </section>
      ) : (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Stock</h2>
          <StockTable
            canSeeCost={canSeeCost}
            lowStockOnly={lowStockOnly}
            rows={items.map(toStockRow)}
            stockSummary={stockSummary}
            storeId={activeStoreId}
          />
        </section>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <button
            className="rounded-lg border border-border bg-surface px-6 py-3 text-sm font-medium text-text hover:bg-canvas disabled:opacity-60"
            disabled={isPending}
            onClick={handleLoadMore}
            type="button"
          >
            {isPending ? 'Chargement…' : 'Voir plus'}
          </button>
        </div>
      )}
    </div>
  );
}

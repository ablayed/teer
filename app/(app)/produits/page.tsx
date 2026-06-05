import { ProductsCatalog } from '@/components/products/products-catalog';
import { PurchaseLotsView } from '@/components/purchases/purchase-lots-view';
import { StockTable } from '@/components/stock/stock-table';
import { getProductCatalogPageData } from '@/lib/actions/products';
import { getPurchaseLotPageData } from '@/lib/actions/purchases';
import { getStockPageData } from '@/lib/actions/stock';
import { getTranslations } from 'next-intl/server';

export default async function ProduitsPage() {
  const nav = await getTranslations('nav');
  const [catalogResult, stockResult, purchaseResult] = await Promise.all([
    getProductCatalogPageData(),
    getStockPageData(),
    getPurchaseLotPageData(),
  ]);

  const isOwner = catalogResult.ok && catalogResult.currentRole === 'owner';

  return (
    <main className="space-y-10" id="main">
      <h1 className="font-display text-4xl md:text-5xl">{nav('produits')}</h1>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Catalogue</h2>
        {!catalogResult.ok ? (
          <div className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
            {catalogResult.errorCode === 'unauthenticated'
              ? 'Session introuvable.'
              : catalogResult.errorCode === 'forbidden'
                ? "Vous n'avez pas accès au catalogue produit."
                : 'Le catalogue produit est indisponible pour le moment.'}
          </div>
        ) : (
          <ProductsCatalog
            currentRole={catalogResult.currentRole}
            products={catalogResult.products}
          />
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-semibold">Stock</h2>
        {!stockResult.ok ? (
          <div className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
            {stockResult.message}
          </div>
        ) : (
          <StockTable canSeeCost={stockResult.canSeeCost} rows={stockResult.rows} />
        )}
      </section>

      {isOwner && (
        <section className="space-y-4">
          <h2 className="text-xl font-semibold">Achats fournisseur</h2>
          {!purchaseResult.ok ? (
            <div className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
              {purchaseResult.message}
            </div>
          ) : (
            <PurchaseLotsView lots={purchaseResult.lots} products={catalogResult.products} />
          )}
        </section>
      )}
    </main>
  );
}

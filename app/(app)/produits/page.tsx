import { ProductsPageLoader } from '@/components/products/products-page-loader';
import { PurchaseLotsView } from '@/components/purchases/purchase-lots-view';
import { getProductCatalogPageData, getProductsPageData } from '@/lib/actions/products';
import { getPurchaseLotPageData, getPurchaseLotProfitability } from '@/lib/actions/purchases';
import { getRequestStoreId } from '@/lib/workspace/store';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Tab = 'catalogue' | 'stock' | 'achats';

export default async function ProduitsPage({ searchParams }: { searchParams: SearchParams }) {
  const nav = await getTranslations('nav');
  const params = await searchParams;
  const storeId = await getRequestStoreId();
  if (!storeId) redirect('/s');
  const q = typeof params.q === 'string' ? params.q : '';
  const rawTab = typeof params.tab === 'string' ? params.tab : '';
  const tab: Tab = rawTab === 'stock' ? 'stock' : rawTab === 'achats' ? 'achats' : 'catalogue';

  if (tab === 'achats') {
    const [catalogResult, purchaseResult] = await Promise.all([
      getProductCatalogPageData(storeId),
      getPurchaseLotPageData(storeId),
    ]);

    const isOwner = catalogResult.ok && catalogResult.currentRole === 'owner';

    // Rentabilité chargée uniquement pour les lots reçus (F2) : un lot pas
    // encore reçu n'a ni CA encaissé ni coût de revient figé, la RPC n'a rien
    // d'utile à calculer avant réception. Passée depuis la page (server) plutôt
    // qu'appelée depuis le client — évite d'ouvrir une nouvelle surface RPC
    // client-callable pour une lecture déjà disponible côté serveur.
    const profitabilityEntries = purchaseResult.ok
      ? await Promise.all(
          purchaseResult.lots
            .filter((lot) => lot.status === 'received')
            .map(async (lot) => [lot.id, await getPurchaseLotProfitability(lot.id)] as const),
        )
      : [];
    const profitabilityByLotId = Object.fromEntries(profitabilityEntries);

    return (
      <main className="space-y-8" id="main">
        <h1 className="font-display text-4xl md:text-5xl">{nav('produits')}</h1>
        <TabBar isOwner={isOwner} storeId={storeId} tab="achats" />
        {!isOwner ? (
          <div className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
            Accès réservé au propriétaire.
          </div>
        ) : !purchaseResult.ok ? (
          <div className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
            {purchaseResult.message}
          </div>
        ) : (
          <PurchaseLotsView
            lots={purchaseResult.lots}
            products={catalogResult.ok ? catalogResult.products : []}
            profitabilityByLotId={profitabilityByLotId}
          />
        )}
      </main>
    );
  }

  const productsResult = await getProductsPageData({ q: q.trim() || undefined, shopId: storeId });

  const isOwner = productsResult.ok && productsResult.currentRole === 'owner';

  return (
    <main className="space-y-8" id="main">
      <h1 className="font-display text-4xl md:text-5xl">{nav('produits')}</h1>
      <TabBar isOwner={isOwner} storeId={storeId} tab={tab} />
      {!productsResult.ok ? (
        <div className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
          {productsResult.errorCode === 'unauthenticated'
            ? 'Session introuvable.'
            : productsResult.errorCode === 'forbidden'
              ? "Vous n'avez pas accès au catalogue produit."
              : 'Le catalogue est indisponible pour le moment.'}
        </div>
      ) : (
        <ProductsPageLoader
          canSeeCost={productsResult.canSeeCost}
          currentRole={productsResult.currentRole}
          initialHasMore={productsResult.hasMore}
          initialItems={productsResult.items}
          initialNextOffset={productsResult.nextOffset}
          searchQuery={q}
          storeId={storeId}
          view={tab === 'stock' ? 'stock' : 'catalogue'}
        />
      )}
    </main>
  );
}

function TabBar({ isOwner, storeId, tab }: { isOwner: boolean; storeId: string; tab: Tab }) {
  const tabClass = (active: boolean) =>
    `px-4 py-2 text-sm font-medium ${
      active ? 'border-b-2 border-accent text-text' : 'text-muted hover:text-text'
    }`;

  return (
    <nav aria-label="Onglets produits" className="flex gap-1 border-b border-border">
      <Link
        aria-current={tab === 'catalogue' ? 'page' : undefined}
        className={tabClass(tab === 'catalogue')}
        href={`/s/${storeId}/produits`}
      >
        Catalogue
      </Link>
      <Link
        aria-current={tab === 'stock' ? 'page' : undefined}
        className={tabClass(tab === 'stock')}
        href={`/s/${storeId}/produits?tab=stock`}
      >
        Stock
      </Link>
      {isOwner && (
        <Link
          aria-current={tab === 'achats' ? 'page' : undefined}
          className={tabClass(tab === 'achats')}
          href={`/s/${storeId}/produits?tab=achats`}
        >
          Achats fournisseur
        </Link>
      )}
    </nav>
  );
}

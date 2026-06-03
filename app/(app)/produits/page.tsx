import { ProductsCatalog } from '@/components/products/products-catalog';
import { getProductCatalogPageData } from '@/lib/actions/products';
import { getTranslations } from 'next-intl/server';

export default async function ProduitsPage() {
  const nav = await getTranslations('nav');
  const result = await getProductCatalogPageData();

  return (
    <main className="space-y-6" id="main">
      <h1 className="font-display text-4xl md:text-5xl">{nav('produits')}</h1>
      {!result.ok ? (
        <section className="rounded-lg border border-danger/30 bg-surface p-6 text-sm text-danger shadow-1">
          {result.errorCode === 'unauthenticated'
            ? 'Session introuvable.'
            : result.errorCode === 'forbidden'
              ? 'Vous n’avez pas accès au catalogue produit.'
              : 'Le catalogue produit est indisponible pour le moment.'}
        </section>
      ) : (
        <ProductsCatalog currentRole={result.currentRole} products={result.products} />
      )}
    </main>
  );
}

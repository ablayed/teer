// SHOPIFY-OAUTH-FIRST-01 / B3 — confirmation du rattachement d'une installation Shopify.
//
// GET en LECTURE SEULE (invariant 3 du plan, T15) : aucune écriture serveur, quel que soit le
// cas. La décision vit dans lib/shopify/claim-view.ts, les lectures dans ./load-claim-view.ts ;
// le rattachement ne part que du POST explicite. Page dynamique, jamais prérendue : elle lit un
// cookie et une session.
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ClaimConfirmForm } from './claim-confirm-form';
import { loadShopifyClaimPageView } from './load-claim-view';

export const dynamic = 'force-dynamic';

function ClaimMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="font-display text-2xl">{title}</h1>
      <div className="mt-3 text-sm text-muted">{children}</div>
    </main>
  );
}

export default async function ShopifyClaimPage() {
  const view = await loadShopifyClaimPageView();

  if (view.kind === 'redirect') {
    redirect(view.to);
  }

  if (view.kind === 'ticket_invalid') {
    return (
      <ClaimMessage title="Ce lien de rattachement n’est plus valide">
        <p>Rouvrez Tëër depuis votre administration Shopify pour recommencer.</p>
      </ClaimMessage>
    );
  }

  if (view.kind === 'forbidden') {
    return (
      <ClaimMessage title="Rattachement réservé">
        <p>
          Seul un propriétaire ou un gestionnaire de l’espace peut rattacher une boutique Shopify.
        </p>
      </ClaimMessage>
    );
  }

  if (view.kind === 'error') {
    return (
      <ClaimMessage title="Une erreur est survenue">
        <p>Réessayez dans un instant.</p>
      </ClaimMessage>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="font-display text-2xl">Rattacher cette boutique à Tëër</h1>
      <p className="mt-6 text-sm text-muted">Boutique Shopify</p>
      <p className="mt-1 break-all font-mono text-xl font-semibold" data-testid="claim-shop-domain">
        {view.shopDomain}
      </p>
      <p className="mt-6 text-sm text-muted">
        Elle sera rattachée à l’espace{' '}
        <span className="font-semibold text-text">{view.accountName}</span>. Vérifiez le nom de la
        boutique avant de confirmer.
      </p>
      <ClaimConfirmForm />
    </main>
  );
}

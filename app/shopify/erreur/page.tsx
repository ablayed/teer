// SHOPIFY-OAUTH-FIRST-01 / D15 — surface d'erreur publique du parcours Shopify sans session.
//
// Seul le code (énumération fermée, lib/shopify/public-error.ts) est lu dans la requête ; un code
// inconnu est affiché comme `unknown`. Le message est FIXE et choisi côté serveur : aucun texte
// ne vient de la requête, aucun domaine, aucun locataire, aucune application n'est cité.
import { publicEnv } from '@/lib/env';
import {
  SHOPIFY_PUBLIC_ERROR_MESSAGES,
  parseShopifyPublicErrorCode,
} from '@/lib/shopify/public-error';

export const dynamic = 'force-dynamic';

type ShopifyErrorPageProps = {
  searchParams: Promise<{ code?: string | string[] }>;
};

export default async function ShopifyErrorPage({ searchParams }: ShopifyErrorPageProps) {
  const { code: rawCode } = await searchParams;
  const code = parseShopifyPublicErrorCode(typeof rawCode === 'string' ? rawCode : undefined);
  const message = SHOPIFY_PUBLIC_ERROR_MESSAGES[code];
  const supportEmail = publicEnv.NEXT_PUBLIC_SUPPORT_EMAIL;

  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center" data-error={code}>
      <h1 className="font-display text-2xl">{message.title}</h1>
      <p className="mt-3 text-sm text-muted">{message.body}</p>
      {message.contactSupport ? (
        <p className="mt-3 text-sm text-muted">
          {supportEmail ? (
            <>
              Contactez le support :{' '}
              <a className="font-medium text-text underline" href={`mailto:${supportEmail}`}>
                {supportEmail}
              </a>
              .
            </>
          ) : (
            'Contactez le support.'
          )}
        </p>
      ) : null}
    </main>
  );
}

'use client';

// SHOPIFY-OAUTH-FIRST-01 / B4 — bouton unique de confirmation. Aucune donnée n'est envoyée : le
// ticket voyage dans son cookie, l'utilisateur et l'espace viennent de la session côté serveur.
import { claimShopifyInstallationAction } from '@/lib/actions/shopify-claim';
import { useAction } from 'next-safe-action/hooks';

const IN_PROGRESS_MESSAGE =
  'Une autre opération est en cours sur cette boutique. Patientez quelques instants, puis réessayez.';
const GENERIC_MESSAGE = 'Une erreur est survenue. Réessayez dans un instant.';

export function ClaimConfirmForm() {
  const claim = useAction(claimShopifyInstallationAction);

  // Toute erreur serveur arrive aplatie (`UNEXPECTED_ERROR`, lib/actions/safe-action.ts) : un
  // refus de rôle ou de session n'est pas distinguable ici. Le GET nomme déjà le refus de rôle.
  const errorMessage =
    claim.result.data?.ok === false
      ? IN_PROGRESS_MESSAGE
      : claim.result.serverError
        ? GENERIC_MESSAGE
        : null;

  return (
    <form
      className="mt-8 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        claim.execute({});
      }}
    >
      {errorMessage ? (
        <p className="text-sm text-danger" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={claim.status === 'executing'}
        className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-text disabled:opacity-60"
      >
        {claim.status === 'executing' ? 'Rattachement en cours…' : 'Rattacher la boutique'}
      </button>
    </form>
  );
}

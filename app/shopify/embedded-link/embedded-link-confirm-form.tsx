'use client';

import { linkShopifyEmbeddedShopAction } from '@/lib/actions/shopify-embedded-link';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useState } from 'react';

type MerchantAccountOption = { id: string; name: string };

type EmbeddedLinkConfirmFormProps = {
  intent: string;
  accounts: MerchantAccountOption[];
};

const ERROR_MESSAGES: Record<string, string> = {
  intent_invalid: 'Ce lien a expiré. Retournez dans Shopify Admin et réessayez.',
  app_unknown: 'Cette application Shopify n’est plus reconnue. Contactez le support.',
  not_a_member: 'Vous n’avez pas accès à ce compte marchand.',
  app_switch_refused:
    'Cette boutique est déjà associée à une autre application Tëër. Contactez le support.',
  ownership_refused: 'Cette boutique est déjà associée à un autre compte. Contactez le support.',
  write_failed: 'Une erreur est survenue. Réessayez dans un instant.',
  destination_unavailable: 'Impossible de revenir vers Shopify Admin. Réessayez depuis Shopify.',
};

export function EmbeddedLinkConfirmForm({ intent, accounts }: EmbeddedLinkConfirmFormProps) {
  const [merchantAccountId, setMerchantAccountId] = useState(accounts[0]?.id ?? '');
  const link = useAction(linkShopifyEmbeddedShopAction);

  useEffect(() => {
    if (link.result.data?.ok === true) {
      window.location.href = link.result.data.redirectUrl;
    }
  }, [link.result.data]);

  const errorCode = link.result.data?.ok === false ? link.result.data.errorCode : undefined;
  const errorMessage = errorCode
    ? (ERROR_MESSAGES[errorCode] ?? ERROR_MESSAGES.write_failed)
    : link.result.serverError
      ? ERROR_MESSAGES.write_failed
      : null;

  return (
    <form
      className="mt-6 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        link.execute({ intent, merchantAccountId });
      }}
    >
      {accounts.length > 1 ? (
        <div className="space-y-2">
          <label htmlFor="merchant-account" className="text-sm font-medium">
            Compte marchand
          </label>
          <select
            id="merchant-account"
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
            value={merchantAccountId}
            onChange={(event) => setMerchantAccountId(event.target.value)}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="text-sm font-medium">{accounts[0]?.name}</p>
      )}

      {errorMessage ? (
        <p className="text-sm text-danger" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={link.status === 'executing' || !merchantAccountId}
        className="inline-flex min-h-12 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-text disabled:opacity-60"
      >
        {link.status === 'executing' ? 'Association en cours…' : 'Confirmer le rattachement'}
      </button>
    </form>
  );
}

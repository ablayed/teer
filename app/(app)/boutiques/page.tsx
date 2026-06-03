import { ConnectShopForm } from '@/components/shops/connect-shop-form';
import { DisconnectShopButton } from '@/components/shops/disconnect-shop-button';
import { getShopConnection } from '@/lib/actions/shopify';
import { formatDateAbsolute } from '@/lib/format/date';
import { hasShopifyScope } from '@/lib/shopify/oauth';
import { AlertCircle, CheckCircle2, Store } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

type BoutiquesPageProps = {
  searchParams: Promise<{
    connected?: string;
    error?: string;
  }>;
};

const knownErrorCodes = [
  'invalid_shop',
  'invalid_state',
  'state_mismatch',
  'shop_mismatch',
  'invalid_hmac',
  'connection_failed',
] as const;

type ErrorCode = (typeof knownErrorCodes)[number];
type ScopeTranslationKey = 'scopes.orders' | 'scopes.customers' | 'scopes.products';

function isErrorCode(value: string): value is ErrorCode {
  return knownErrorCodes.includes(value as ErrorCode);
}

function readableScopes(scopes: string, t: (key: ScopeTranslationKey) => string) {
  const scopeLabels = scopes
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
    .map((scope) => {
      if (scope === 'read_orders') {
        return t('scopes.orders');
      }

      if (scope === 'read_customers') {
        return t('scopes.customers');
      }

      if (scope === 'read_products') {
        return t('scopes.products');
      }

      return scope;
    });

  return scopeLabels.join(', ');
}

export default async function BoutiquesPage({ searchParams }: BoutiquesPageProps) {
  const t = await getTranslations('shops');
  const params = await searchParams;
  const shopConnection = await getShopConnection();
  const errorCode = params.error && isErrorCode(params.error) ? params.error : null;
  const showSuccess = params.connected === '1';
  const needsProductReconnect = shopConnection
    ? !hasShopifyScope(shopConnection.scopes, 'read_products')
    : false;

  return (
    <main className="space-y-6" id="main">
      <div className="space-y-2">
        <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
        {!shopConnection ? <p className="max-w-2xl text-muted">{t('subtitle')}</p> : null}
      </div>

      {showSuccess ? (
        <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-surface p-4 text-success">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p className="text-sm font-medium">{t('messages.connected')}</p>
        </div>
      ) : null}

      {errorCode ? (
        <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-surface p-4 text-danger">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p className="text-sm font-medium">{t(`errors.${errorCode}`)}</p>
        </div>
      ) : null}

      {shopConnection && needsProductReconnect ? (
        <div className="flex flex-col gap-3 rounded-lg border border-warning/30 bg-surface p-4 text-text">
          <div className="flex items-start gap-3 text-warning">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <p className="text-sm font-medium">{t('messages.productsScopeRequired')}</p>
          </div>
          <div>
            <Link
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-canvas px-4 text-sm font-medium text-text shadow-1"
              href={`/api/shopify/install?shop=${encodeURIComponent(shopConnection.shop_domain)}`}
            >
              {t('messages.productsScopeCta')}
            </Link>
          </div>
        </div>
      ) : null}

      {!shopConnection ? (
        <section className="max-w-2xl rounded-lg border border-border bg-surface p-6 shadow-1">
          <div className="mb-6 flex items-start gap-4">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-canvas text-accent">
              <Store aria-hidden="true" className="size-6" />
            </span>
            <div className="space-y-1">
              <h2 className="text-xl font-semibold">{t('connect.title')}</h2>
              <p className="text-sm leading-6 text-muted">{t('connect.description')}</p>
            </div>
          </div>
          <ConnectShopForm />
        </section>
      ) : (
        <section className="max-w-3xl rounded-lg border border-border bg-surface p-6 shadow-1">
          <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-canvas text-accent">
                  <Store aria-hidden="true" className="size-6" />
                </span>
                <div>
                  <h2 className="text-xl font-semibold">{shopConnection.shop_domain}</h2>
                  <span className="mt-2 inline-flex items-center gap-2 rounded-full border border-success/30 bg-canvas px-3 py-1 text-sm font-medium text-success">
                    <CheckCircle2 aria-hidden="true" className="size-4" />
                    {t('status.connected')}
                  </span>
                </div>
              </div>

              <dl className="grid gap-4 text-sm md:grid-cols-2">
                <div>
                  <dt className="font-medium text-text">{t('connected.scopes')}</dt>
                  <dd className="mt-1 text-muted">{readableScopes(shopConnection.scopes, t)}</dd>
                </div>
                <div>
                  <dt className="font-medium text-text">{t('connected.installedAt')}</dt>
                  <dd className="mt-1 text-muted">
                    {formatDateAbsolute(shopConnection.installed_at)}
                  </dd>
                </div>
              </dl>
            </div>

            <DisconnectShopButton />
          </div>
        </section>
      )}
    </main>
  );
}

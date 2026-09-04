'use client';

import { Button } from '@/components/ui/button';
import {
  type ShopListItem,
  disconnectShopAction,
  listShopsAction,
  syncShopAction,
} from '@/lib/actions/shops';
import { formatDateAbsolute, formatDateRelative } from '@/lib/format/date';
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw, Store, Unplug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';

type SettingsShopsProps = {
  currentRole: string;
};

type StatusView = {
  className: string;
  icon: typeof CheckCircle2;
  label: string;
};

// Les 7 codes réellement émis par app/api/shopify/callback/route.ts et
// app/api/shopify/install/route.ts (audité à la main, cf. rapport SHOP-01).
// Un code émis mais absent d'ici tomberait sur errors.generic, jamais un silence.
const oauthErrorCodes = [
  'invalid_shop',
  'invalid_state',
  'state_mismatch',
  'shop_mismatch',
  'invalid_hmac',
  'connection_failed',
  'unknown_client_id',
] as const;

type OauthErrorCode = (typeof oauthErrorCodes)[number];

function isOauthErrorCode(value: string): value is OauthErrorCode {
  return oauthErrorCodes.includes(value as OauthErrorCode);
}

function shopNameFromDomain(domain: string): string {
  return domain.replace(/\.myshopify\.com$/, '');
}

// Copie pure de lib/shopify/oauth.ts#hasShopifyScope : cette dernière importe
// node:crypto (verifyOAuthHmac) au niveau du module, donc l'importer depuis ce
// composant client ('use client') casse le build webpack — jamais réimportée
// depuis le module serveur.
function hasShopifyScope(scopes: string | null | undefined, scope: string): boolean {
  if (!scopes) {
    return false;
  }

  return scopes
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(scope);
}

export function SettingsShops({ currentRole }: SettingsShopsProps) {
  const t = useTranslations('settings.shops');
  const canManage = currentRole === 'owner' || currentRole === 'manager';
  const isOwner = currentRole === 'owner';
  const listShops = useAction(listShopsAction);
  const syncShop = useAction(syncShopAction);
  const disconnectShop = useAction(disconnectShopAction);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncingShopId, setSyncingShopId] = useState<string | null>(null);
  const data = listShops.result.data?.ok ? listShops.result.data : null;
  // Retour du flux OAuth Shopify (callback/install route.ts), déplacé ici depuis
  // l'ancienne page /boutiques — désormais une simple redirection vers cet onglet.
  const [connectedParam] = useQueryState('connected');
  const [errorParam] = useQueryState('error');
  const showOauthSuccess = connectedParam === '1';
  const oauthErrorMessage = errorParam
    ? isOauthErrorCode(errorParam)
      ? t(`errors.${errorParam}`)
      : t('errors.generic')
    : null;

  useEffect(() => {
    if (canManage) {
      listShops.execute({});
    }
  }, [canManage, listShops.execute]);

  const oauthBanners = (
    <>
      {showOauthSuccess ? (
        <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-surface p-4 text-success">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p className="text-sm font-medium">{t('messages.connected')}</p>
        </div>
      ) : null}

      {oauthErrorMessage ? (
        <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-surface p-4 text-danger">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p className="text-sm font-medium">{oauthErrorMessage}</p>
        </div>
      ) : null}
    </>
  );

  if (!canManage) {
    return (
      <div className="space-y-6">
        {oauthBanners}
        <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted shadow-1">
          {t('restricted')}
        </div>
      </div>
    );
  }

  const shops = data?.shops ?? [];
  const loading = listShops.isExecuting && !data;

  function refresh(message?: string) {
    if (message) {
      setNotice(message);
    }

    setError(null);
    listShops.execute({});
  }

  function fail() {
    setNotice(null);
    setError(t('errors.generic'));
  }

  async function onSync(shopId: string) {
    setSyncingShopId(shopId);
    const result = await syncShop.executeAsync({ shopId });
    setSyncingShopId(null);

    if (result?.data?.ok) {
      refresh(t('notices.synced', { count: result.data.syncedCount }));
      return;
    }

    fail();
  }

  async function onDisconnect(shopId: string) {
    if (!window.confirm(t('disconnect.confirm'))) {
      return;
    }

    const result = await disconnectShop.executeAsync({ shopId });

    if (result?.data?.ok) {
      refresh(t('notices.disconnected'));
      return;
    }

    fail();
  }

  return (
    <div className="space-y-6">
      {oauthBanners}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('title')}</h2>
          <p className="mt-1 text-sm text-muted">{t('description')}</p>
        </div>
        <Link
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-accent px-5 font-medium text-accent-ink transition hover:bg-accent-hover"
          href="/boutiques"
        >
          <ExternalLink aria-hidden="true" className="h-4 w-4" />
          {t('connectNew')}
        </Link>
      </div>

      {notice ? (
        <output className="block rounded-lg border border-success/30 bg-success-subtle p-3 text-sm text-success">
          {notice}
        </output>
      ) : null}

      {error || listShops.result.data?.ok === false ? (
        <div
          className="flex items-start justify-between gap-3 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm text-danger"
          role="alert"
        >
          <span>{error ?? t('errors.generic')}</span>
          <Button
            onClick={() => listShops.execute({})}
            size="sm"
            type="button"
            variant="destructive"
          >
            {t('retry')}
          </Button>
        </div>
      ) : null}

      {loading ? <ShopsSkeleton /> : null}

      {!loading && shops.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
          <div className="mb-5 flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-canvas text-text">
              <Store aria-hidden="true" className="h-5 w-5" />
            </span>
            <div>
              <h3 className="font-semibold text-text">{t('empty.title')}</h3>
              <p className="mt-1 text-sm leading-6 text-muted">{t('empty.description')}</p>
            </div>
          </div>
          <p className="text-sm leading-6 text-muted">{t('empty.instructions')}</p>
        </section>
      ) : null}

      <div className="grid gap-4">
        {shops.map((shop) => (
          <ShopCard
            canDisconnect={isOwner}
            isSyncing={syncingShopId === shop.id}
            key={shop.id}
            onDisconnect={() => onDisconnect(shop.id)}
            onSync={() => onSync(shop.id)}
            shop={shop}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function statusView(
  shop: ShopListItem,
  t: ReturnType<typeof useTranslations<'settings.shops'>>,
): StatusView {
  if (shop.status === 'error') {
    return {
      className: 'border-danger/30 bg-danger text-white',
      icon: AlertCircle,
      label: t('status.error'),
    };
  }

  if (shop.status === 'uninstalled') {
    return {
      className: 'border-border bg-canvas text-muted',
      icon: Unplug,
      label: t('status.uninstalled'),
    };
  }

  return {
    className: 'border-success/30 bg-success text-white',
    icon: CheckCircle2,
    label: t('status.connected'),
  };
}

function ShopCard({
  canDisconnect,
  isSyncing,
  onDisconnect,
  onSync,
  shop,
  t,
}: {
  canDisconnect: boolean;
  isSyncing: boolean;
  onDisconnect: () => void;
  onSync: () => void;
  shop: ShopListItem;
  t: ReturnType<typeof useTranslations<'settings.shops'>>;
}) {
  const view = statusView(shop, t);
  const StatusIcon = view.icon;
  const syncDisabled = shop.status !== 'connected' || isSyncing;
  // Un scope manquant n'est pas un jeton expiré : une boutique au jeton valide
  // peut manquer read_products (reconnexion Shopify Admin plus ancienne, scope
  // ajouté depuis). Message distinct de `reason === 'token_expired'` ci-dessous.
  const needsProductScope =
    shop.status === 'connected' && !hasShopifyScope(shop.scopes, 'read_products');

  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-4">
          <div className="flex items-start gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-canvas text-text">
              <Store aria-hidden="true" className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-lg font-semibold text-text">
                {shopNameFromDomain(shop.domain)}
              </h3>
              <p className="truncate font-mono text-sm tabular-nums text-muted">{shop.domain}</p>
              <span
                className={`mt-2 inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium ${view.className}`}
              >
                <StatusIcon aria-hidden="true" className="h-4 w-4" />
                {isSyncing ? t('status.syncing') : view.label}
              </span>
            </div>
          </div>

          <dl className="grid gap-3 text-sm md:grid-cols-2">
            <div>
              <dt className="font-medium text-text">{t('installedAt')}</dt>
              <dd className="mt-1 text-muted">{formatDateAbsolute(shop.installedAt)}</dd>
            </div>
            <div>
              <dt className="font-medium text-text">{t('lastSync')}</dt>
              <dd className="mt-1 text-muted">
                {shop.lastSyncAt ? formatDateRelative(shop.lastSyncAt) : t('neverSynced')}
              </dd>
            </div>
          </dl>

          {shop.status === 'error' ? (
            <div className="rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger">
              <p>
                {shop.reason === 'token_expired' ? t('reasons.tokenExpired') : t('reasons.generic')}
              </p>
              <p className="mt-3 text-sm text-muted">{t('reasons.reconnectInstructions')}</p>
            </div>
          ) : null}

          {needsProductScope ? (
            <div className="rounded-md border border-warning/30 bg-warning/15 p-3 text-sm">
              <p className="text-warning">{t('reasons.productsScopeRequired')}</p>
              <p className="mt-3 text-sm text-muted">{t('reasons.productsScopeInstructions')}</p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row md:flex-col">
          <Button disabled={syncDisabled} onClick={onSync} type="button" variant="secondary">
            <RefreshCw
              aria-hidden="true"
              className={`h-4 w-4 ${isSyncing ? 'animate-spin' : ''}`}
            />
            {isSyncing ? t('syncing') : t('sync')}
          </Button>
          {canDisconnect ? (
            <Button onClick={onDisconnect} type="button" variant="destructive">
              {t('disconnect.submit')}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ShopsSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {[0, 1].map((item) => (
        <div
          className="h-44 animate-pulse rounded-lg border border-border bg-surface shadow-1"
          key={item}
        />
      ))}
    </div>
  );
}

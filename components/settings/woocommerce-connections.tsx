'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type WooCommerceConnectionListItem,
  completeWooCommerceConnectionAction,
  createWooCommerceConnectionIntentAction,
  listWooCommerceConnectionsAction,
} from '@/lib/actions/woocommerce';
import { AlertCircle, CheckCircle2, Clock, Link2, RefreshCw, Store } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useMemo, useState } from 'react';

export function WooCommerceConnections({ currentRole }: { currentRole: string }) {
  const t = useTranslations('settings.shops.woocommerce');
  const list = useAction(listWooCommerceConnectionsAction);
  const createIntent = useAction(createWooCommerceConnectionIntentAction);
  const complete = useAction(completeWooCommerceConnectionAction);
  const [selectedShopId, setSelectedShopId] = useState('');
  const [shopUrl, setShopUrl] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);

  const data = list.result.data?.ok ? list.result.data : null;
  const shops = data?.shops ?? [];
  const connections = data?.connections ?? [];
  const canCreateNewShop = data?.canCreateNewShop ?? false;
  const connectionByShop = useMemo(
    () => new Map(connections.map((connection) => [connection.shopId, connection])),
    [connections],
  );
  const selectedConnection = selectedShopId ? connectionByShop.get(selectedShopId) : undefined;
  const canManage = currentRole === 'owner' || currentRole === 'manager';

  useEffect(() => {
    if (canManage) list.execute({});
  }, [canManage, list.execute]);

  useEffect(() => {
    if (!selectedShopId && shops[0]) setSelectedShopId(shops[0].id);
  }, [selectedShopId, shops]);

  useEffect(() => {
    if (selectedConnection) setShopUrl(selectedConnection.externalIdentifier);
    else if (selectedShopId) {
      const shop = shops.find((item) => item.id === selectedShopId);
      setShopUrl(shop?.domain.startsWith('https://') ? shop.domain : '');
    }
  }, [selectedConnection, selectedShopId, shops]);

  if (!canManage) return null;

  async function startConnection() {
    setNotice(null);
    setError(null);
    if ((!canCreateNewShop && !selectedShopId) || !shopUrl.trim()) {
      setError(t('errors.missingFields'));
      return;
    }
    const result = await createIntent.executeAsync({
      ...(selectedShopId ? { shopId: selectedShopId } : {}),
      shopUrl: shopUrl.trim(),
    });
    if (result?.data?.ok) {
      window.location.assign(result.data.authorizeUrl);
      return;
    }
    setError(
      result?.data?.errorCode === 'existing_shop_required'
        ? t('errors.existingShopRequired')
        : t('errors.connectionFailed'),
    );
  }

  async function retryConnection(connection: WooCommerceConnectionListItem) {
    setBusyConnectionId(connection.id);
    setNotice(null);
    setError(null);
    const result = await complete.executeAsync({ connectionId: connection.id });
    setBusyConnectionId(null);
    if (result?.data?.ok) {
      setNotice(t('notices.ready'));
      list.execute({});
      return;
    }
    setError(t('errors.retryFailed'));
    list.execute({});
  }

  return (
    <section className="space-y-5 rounded-lg border border-border bg-surface p-5 shadow-1">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-canvas text-text">
          <Store aria-hidden="true" className="h-5 w-5" />
        </span>
        <div>
          <h3 className="font-semibold text-text">{t('title')}</h3>
          <p className="mt-1 text-sm leading-6 text-muted">{t('description')}</p>
        </div>
      </div>

      {notice ? (
        <output className="block rounded-md border border-success/30 bg-success-subtle p-3 text-sm text-success">
          {notice}
        </output>
      ) : null}
      {error ? (
        <p
          className="rounded-md border border-danger/30 bg-danger-subtle p-3 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {canCreateNewShop || shops.length > 0 ? (
        <div className="grid gap-4 rounded-md border border-border bg-canvas p-4 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] md:items-end">
          {shops.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="woocommerce-shop">{t('fields.shop')}</Label>
              <select
                className="h-12 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 focus:border-accent"
                id="woocommerce-shop"
                onChange={(event) => setSelectedShopId(event.target.value)}
                value={selectedShopId}
              >
                {shops.map((shop) => (
                  <option key={shop.id} value={shop.id}>
                    {shop.displayName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="woocommerce-url">{t('fields.url')}</Label>
            <Input
              disabled={Boolean(selectedConnection)}
              id="woocommerce-url"
              onChange={(event) => setShopUrl(event.target.value)}
              placeholder="https://votre-boutique.example"
              type="url"
              value={shopUrl}
            />
            <p className="text-xs leading-5 text-muted">{t('fields.urlHint')}</p>
          </div>
          <div className="md:col-span-2">
            <Button
              disabled={
                createIntent.isExecuting ||
                Boolean(selectedConnection && selectedConnection.status !== 'needs_reauth')
              }
              onClick={startConnection}
              type="button"
            >
              <Link2 aria-hidden="true" className="h-4 w-4" />
              {selectedConnection?.status === 'needs_reauth'
                ? t('actions.reauthorize')
                : t('actions.connect')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-border bg-canvas p-4 text-sm text-muted">
          {t('empty')}
        </p>
      )}

      <div className="space-y-3">
        {connections.map((connection) => (
          <WooConnectionCard
            connection={connection}
            disabled={busyConnectionId !== null}
            isBusy={busyConnectionId === connection.id}
            key={connection.id}
            onRetry={() => retryConnection(connection)}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}

function WooConnectionCard({
  connection,
  disabled,
  isBusy,
  onRetry,
  t,
}: {
  connection: WooCommerceConnectionListItem;
  disabled: boolean;
  isBusy: boolean;
  onRetry: () => void;
  t: ReturnType<typeof useTranslations<'settings.shops.woocommerce'>>;
}) {
  const subscriptionsReady =
    connection.subscriptions['order.created'] === 'active' &&
    connection.subscriptions['order.updated'] === 'active';
  const needsRetry =
    connection.status === 'provisioning' ||
    (connection.status === 'active' && !subscriptionsReady) ||
    connection.syncStatus === 'failed';
  const status =
    connection.status === 'active' && subscriptionsReady ? 'active' : connection.status;
  const StatusIcon =
    status === 'active' ? CheckCircle2 : status === 'needs_reauth' ? AlertCircle : Clock;

  return (
    <article className="rounded-md border border-border p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <h4 className="font-medium text-text">{connection.shopName}</h4>
          <p className="truncate font-mono text-xs text-muted">{connection.externalIdentifier}</p>
          <span className="inline-flex min-h-8 items-center gap-2 rounded-full border border-border bg-canvas px-3 text-sm text-text">
            <StatusIcon aria-hidden="true" className="h-4 w-4" />
            {t(`status.${status as 'active' | 'provisioning' | 'needs_reauth' | 'uninstalled'}`)}
          </span>
          <p className="text-sm text-muted">
            {connection.syncStatus === 'completed'
              ? t('sync.completed')
              : connection.syncStatus === 'running'
                ? t('sync.running', { page: connection.syncLastPageObserved })
                : connection.syncStatus === 'failed'
                  ? t('sync.failed')
                  : t('sync.notStarted')}
          </p>
        </div>
        {connection.status === 'needs_reauth' ? null : needsRetry ? (
          <Button disabled={disabled} onClick={onRetry} type="button" variant="secondary">
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} />
            {isBusy ? t('actions.inProgress') : t('actions.retry')}
          </Button>
        ) : null}
      </div>
      {connection.status === 'needs_reauth' ? (
        <p className="mt-3 text-sm leading-6 text-danger">{t('reasons.needsReauth')}</p>
      ) : connection.status === 'provisioning' ? (
        <p className="mt-3 text-sm leading-6 text-warning">{t('reasons.provisioning')}</p>
      ) : null}
    </article>
  );
}

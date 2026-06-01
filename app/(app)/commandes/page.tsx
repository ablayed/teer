import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { KanbanBoard, type KanbanColumnView } from '@/components/orders/kanban/KanbanBoard';
import { groupOrdersByKanbanColumn } from '@/components/orders/kanban/kanban-utils';
import { OrdersViewToggle } from '@/components/orders/orders-view-toggle';
import { SyncOrdersButton } from '@/components/orders/sync-orders-button';
import { type OrderListItem, getOrders } from '@/lib/actions/orders';
import { getShopConnection } from '@/lib/actions/shopify';
import { orderStatusLabels } from '@/lib/domain/order-state-machine';
import { formatDateAbsolute } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import { type CodStatus, codStatuses, isCodStatus } from '@/lib/orders/status';
import { AlertCircle, ArrowRight, Store } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

type CommandesPageProps = {
  searchParams: Promise<{
    vue?: string;
    statut?: string;
    sync_error?: string;
    synced?: string;
  }>;
};

const syncErrorCodes = ['no_shop', 'sync_failed', 'token_error'] as const;
type SyncErrorCode = (typeof syncErrorCodes)[number];

function isSyncErrorCode(value: string): value is SyncErrorCode {
  return syncErrorCodes.includes(value as SyncErrorCode);
}

function orderStatus(orderStatus: string): CodStatus {
  return isCodStatus(orderStatus) ? orderStatus : 'A_APPELER';
}

function statusHref(status?: CodStatus): string {
  return status ? `/commandes?statut=${status.toLowerCase()}` : '/commandes?statut=toutes';
}

function statusParam(value: string | undefined): CodStatus | 'toutes' {
  if (!value) {
    return 'A_APPELER';
  }

  if (value === 'toutes') {
    return 'toutes';
  }

  const normalizedValue = value.toUpperCase();
  return isCodStatus(normalizedValue) ? normalizedValue : 'A_APPELER';
}

function orderQueueDate(order: OrderListItem): string {
  return order.created_at_shopify ?? order.created_at;
}

function viewModeParam(value: string | undefined): 'liste' | 'kanban' {
  return value === 'kanban' ? 'kanban' : 'liste';
}

export default async function CommandesPage({ searchParams }: CommandesPageProps) {
  const t = await getTranslations('orders');
  const params = await searchParams;
  const activeView = viewModeParam(params.vue);
  const activeStatus = statusParam(params.statut);
  const [orders, shopConnection] = await Promise.all([getOrders(), getShopConnection()]);
  const visibleOrders =
    activeStatus === 'toutes'
      ? orders
      : orders
          .filter((order) => orderStatus(order.cod_status) === activeStatus)
          .sort((left, right) => orderQueueDate(left).localeCompare(orderQueueDate(right)));
  const statusCounts = Object.fromEntries(
    codStatuses.map((status) => [
      status,
      orders.filter((order) => orderStatus(order.cod_status) === status).length,
    ]),
  ) as Record<CodStatus, number>;
  const syncedCount = params.synced ? Number.parseInt(params.synced, 10) : null;
  const syncError =
    params.sync_error && isSyncErrorCode(params.sync_error) ? params.sync_error : null;
  const showNoShop = orders.length === 0 && !shopConnection;
  const showNoOrdersWithShop = orders.length === 0 && shopConnection;
  const showFilteredEmpty = orders.length > 0 && visibleOrders.length === 0;
  const groupedOrders = groupOrdersByKanbanColumn(orders);
  const kanbanColumns: KanbanColumnView[] = [
    {
      count: groupedOrders.A_APPELER.length,
      emptyLabel: t('kanban.empty'),
      id: 'A_APPELER',
      orders: groupedOrders.A_APPELER,
      title: t('kanban.columns.aAppeler'),
      tone: 'attention',
    },
    {
      count: groupedOrders.TENTEE.length,
      emptyLabel: t('kanban.empty'),
      id: 'TENTEE',
      orders: groupedOrders.TENTEE,
      title: t('kanban.columns.tentee'),
      tone: 'default',
    },
    {
      count: groupedOrders.CONFIRMEE.length,
      emptyLabel: t('kanban.empty'),
      id: 'CONFIRMEE',
      orders: groupedOrders.CONFIRMEE,
      title: t('kanban.columns.confirmee'),
      tone: 'default',
    },
    {
      count: groupedOrders.EN_LIVRAISON.length,
      emptyLabel: t('kanban.empty'),
      id: 'EN_LIVRAISON',
      orders: groupedOrders.EN_LIVRAISON,
      title: t('kanban.columns.enLivraison'),
      tone: 'default',
    },
    {
      count: groupedOrders.LIVREE.length,
      emptyLabel: t('kanban.empty'),
      id: 'LIVREE',
      orders: groupedOrders.LIVREE,
      title: t('kanban.columns.livree'),
      tone: 'success',
    },
    {
      count: groupedOrders.ANNULEE_REFUSEE.length,
      emptyLabel: t('kanban.empty'),
      id: 'ANNULEE_REFUSEE',
      orders: groupedOrders.ANNULEE_REFUSEE,
      title: t('kanban.columns.cloturee'),
      tone: 'danger',
    },
  ];

  return (
    <main className="space-y-6" id="main">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
          <p className="max-w-2xl text-muted">{t('subtitle')}</p>
        </div>
        <div className="flex flex-col gap-3 sm:items-end">
          <OrdersViewToggle
            activeView={activeView}
            labelKanban={t('kanban.toggle.kanban')}
            labelListe={t('kanban.toggle.liste')}
          />
          <SyncOrdersButton hasShop={Boolean(shopConnection)} />
        </div>
      </div>

      {syncedCount !== null && Number.isFinite(syncedCount) ? (
        <div className="rounded-lg border border-success/30 bg-surface p-4 text-sm font-medium text-success">
          {t('messages.synced', { count: syncedCount })}
        </div>
      ) : null}

      {syncError ? (
        <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-surface p-4 text-danger">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p className="text-sm font-medium">{t(`errors.${syncError}`)}</p>
        </div>
      ) : null}

      {activeView === 'liste' ? (
        <nav aria-label={t('filters.ariaLabel')} className="flex gap-2 overflow-x-auto pb-1">
          <Link
            className={`inline-flex h-10 shrink-0 items-center rounded-full border px-4 text-sm font-medium ${
              activeStatus === 'toutes'
                ? 'border-accent bg-accent text-[#111]'
                : 'border-border bg-surface text-muted hover:bg-canvas'
            }`}
            href={statusHref()}
          >
            {t('filters.all')} ({orders.length})
          </Link>
          {codStatuses.map((status) => (
            <Link
              className={`inline-flex h-10 shrink-0 items-center rounded-full border px-4 text-sm font-medium ${
                activeStatus === status
                  ? 'border-accent bg-accent text-[#111]'
                  : 'border-border bg-surface text-muted hover:bg-canvas'
              }`}
              href={statusHref(status)}
              key={status}
            >
              {orderStatusLabels[status]} ({statusCounts[status]})
            </Link>
          ))}
        </nav>
      ) : null}

      {activeView === 'liste' && (showNoShop || showNoOrdersWithShop || showFilteredEmpty) ? (
        <section className="rounded-lg border border-border bg-surface p-6 shadow-1">
          <div className="flex max-w-2xl flex-col gap-4 sm:flex-row sm:items-start">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-canvas text-accent">
              <Store aria-hidden="true" className="size-6" />
            </span>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold">
                {showNoShop
                  ? t('empty.noShopTitle')
                  : showNoOrdersWithShop
                    ? t('empty.withShopTitle')
                    : t('empty.filteredTitle')}
              </h2>
              <p className="text-sm leading-6 text-muted">
                {showNoShop
                  ? t('empty.noShopDescription')
                  : showNoOrdersWithShop
                    ? t('empty.withShopDescription')
                    : t('empty.filteredDescription')}
              </p>
              {showNoShop ? (
                <Link
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-accent px-4 font-medium text-[#111]"
                  href="/boutiques"
                >
                  {t('empty.noShopCta')}
                  <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
              ) : null}
            </div>
          </div>
        </section>
      ) : null}

      {activeView === 'liste' && visibleOrders.length > 0 ? (
        <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-1">
          <div className="hidden md:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-canvas text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium" scope="col">
                    {t('table.order')}
                  </th>
                  <th className="px-4 py-3 font-medium" scope="col">
                    {t('table.customer')}
                  </th>
                  <th className="px-4 py-3 font-medium" scope="col">
                    {t('table.amount')}
                  </th>
                  <th className="px-4 py-3 font-medium" scope="col">
                    {t('table.status')}
                  </th>
                  <th className="px-4 py-3 font-medium" scope="col">
                    {t('table.date')}
                  </th>
                  <th className="px-4 py-3 text-right font-medium" scope="col">
                    {t('table.details')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleOrders.map((order) => (
                  <tr className="hover:bg-canvas/60" key={order.id}>
                    <td className="font-semibold">
                      <Link className="block px-4 py-4" href={`/commandes/${order.id}`}>
                        {order.order_number ?? t('table.emptyValue')}
                      </Link>
                    </td>
                    <td className="text-muted">
                      <Link className="block px-4 py-4" href={`/commandes/${order.id}`}>
                        {order.customer?.full_name ?? t('table.emptyValue')}
                      </Link>
                    </td>
                    <td className="font-medium">
                      <Link className="block px-4 py-4" href={`/commandes/${order.id}`}>
                        {formatMoney(order.total_amount, order.currency)}
                      </Link>
                    </td>
                    <td>
                      <Link className="block px-4 py-4" href={`/commandes/${order.id}`}>
                        <CodStatusBadge status={orderStatus(order.cod_status)} />
                      </Link>
                    </td>
                    <td className="text-muted">
                      <Link className="block px-4 py-4" href={`/commandes/${order.id}`}>
                        {order.created_at_shopify
                          ? formatDateAbsolute(order.created_at_shopify)
                          : t('table.emptyValue')}
                      </Link>
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Link
                        className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 font-medium text-text hover:bg-canvas"
                        href={`/commandes/${order.id}`}
                      >
                        {t('table.details')}
                        <ArrowRight aria-hidden="true" className="size-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-border md:hidden">
            {visibleOrders.map((order) => (
              <Link
                className="block p-4 hover:bg-canvas/60"
                href={`/commandes/${order.id}`}
                key={order.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{order.order_number ?? t('table.emptyValue')}</p>
                    <p className="mt-1 text-sm text-muted">
                      {order.customer?.full_name ?? t('table.emptyValue')}
                    </p>
                  </div>
                  <CodStatusBadge status={orderStatus(order.cod_status)} />
                </div>
                <div className="mt-4 flex items-end justify-between gap-3">
                  <p className="font-semibold">{formatMoney(order.total_amount, order.currency)}</p>
                  <p className="text-sm text-muted">
                    {order.created_at_shopify
                      ? formatDateAbsolute(order.created_at_shopify)
                      : t('table.emptyValue')}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {activeView === 'kanban' ? (
        <KanbanBoard ariaLabel={t('kanban.ariaLabel')} columns={kanbanColumns} />
      ) : null}
    </main>
  );
}

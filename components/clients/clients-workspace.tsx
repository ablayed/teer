'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet';
import { Amount } from '@/components/ui/amount';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { ResourceRow } from '@/components/ui/resource-row';
import { SearchInput } from '@/components/ui/search-input';
import { ResourceRowSkeleton } from '@/components/ui/skeleton';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import {
  type CustomerDetail,
  type CustomerListItem,
  getCustomerAction,
  listCustomersAction,
} from '@/lib/actions/customers';
import type { ReliabilityTier } from '@/lib/customers/reliability';
import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';
import { formatDateRelative } from '@/lib/format/date';
import { formatPhoneSN, toWhatsAppLink } from '@/lib/format/phone';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertCircle,
  ArrowRight,
  Ban,
  MapPin,
  MessageCircle,
  MoreHorizontal,
  Package,
  Phone,
  Repeat,
  User,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

type Feedback = {
  message: string;
  tone: 'error' | 'success';
};

const skeletonIds = [
  'client-skeleton-a',
  'client-skeleton-b',
  'client-skeleton-c',
  'client-skeleton-d',
  'client-skeleton-e',
  'client-skeleton-f',
];

function isOrderStatus(value: string): value is OrderStatus {
  return orderStatuses.includes(value as OrderStatus);
}

function customerName(customer: Pick<CustomerListItem, 'fullName'>, fallback: string) {
  return customer.fullName || fallback;
}

function tierToTone(tier: ReliabilityTier): StatusTone {
  const map: Record<ReliabilityTier, StatusTone> = {
    new: 'neutral',
    reliable: 'success',
    watch: 'warning',
    risk: 'danger',
  };
  return map[tier];
}

// ── Composants utilisés dans CustomerSheet (intacte) ───────────────────────

const tierStyles: Record<ReliabilityTier, string> = {
  new: 'border-border bg-canvas text-muted',
  reliable: 'border-success bg-success text-white',
  watch: 'border-accent bg-accent text-accent-ink',
  risk: 'border-danger bg-danger text-white',
};

function TierBadge({
  isProvisional,
  tier,
}: {
  isProvisional: boolean;
  tier: ReliabilityTier;
}) {
  const t = useTranslations('clients');
  const title = isProvisional ? t('score.provisional') : undefined;

  return (
    <span
      className={cn(
        'inline-flex min-h-7 items-center rounded-full border px-3 text-xs font-semibold',
        tierStyles[tier],
      )}
      title={title}
    >
      {t(`tiers.${tier}`)}
    </span>
  );
}

function CustomerBadges({
  customer,
}: {
  customer: Pick<CustomerListItem, 'isRecurring' | 'isRefuser'>;
}) {
  const t = useTranslations('clients');

  if (!customer.isRecurring && !customer.isRefuser) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {customer.isRecurring ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-xs font-semibold text-success">
          <Repeat aria-hidden="true" className="size-3" />
          {t('badges.recurring')}
        </span>
      ) : null}
      {customer.isRefuser ? (
        <span className="inline-flex items-center gap-1 rounded-full border border-danger/40 bg-danger-subtle px-2 py-0.5 text-xs font-semibold text-danger">
          <Ban aria-hidden="true" className="size-3" />
          {t('badges.refuser')}
        </span>
      ) : null}
    </div>
  );
}

// ── Meta inline de la ligne client ─────────────────────────────────────────
// Container queries : téléphone + refuseur toujours visibles (si conteneur ≥ 22rem) ;
// nb commandes · montant livré · récurrent uniquement en conteneur large (desktop, ≥ 26rem).

function ClientMeta({ customer }: { customer: CustomerListItem }) {
  const t = useTranslations('clients');

  return (
    <>
      {customer.phone ? formatPhoneSN(customer.phone) : t('fallbackPhone')}
      {customer.isRefuser ? (
        <span className="font-medium text-danger"> · {t('badges.refuser')}</span>
      ) : null}
      <span className="@min-[26rem]/row:inline hidden">
        {' · '}
        {customer.orderCount} {t('list.orders').toLowerCase()}
      </span>
      <span className="@min-[26rem]/row:inline hidden">
        {' · '}
        <Amount amountMinor={customer.deliveredLifetime} />
      </span>
      {customer.isRecurring ? (
        <span className="@min-[26rem]/row:inline hidden"> · {t('badges.recurring')}</span>
      ) : null}
    </>
  );
}

// ── Ligne client (ResourceRow) ──────────────────────────────────────────────

function ClientRow({
  customer,
  onSelect,
  storeId,
}: {
  customer: CustomerListItem;
  onSelect: (customerId: string) => void;
  storeId: string;
}) {
  const t = useTranslations('clients');
  const router = useRouter();
  const phone = customer.phone;
  const name = customerName(customer, t('fallbackName'));

  const tierLabel = customer.isProvisional
    ? `${t(`tiers.${customer.tier}`)} *`
    : t(`tiers.${customer.tier}`);

  const overflowItems: ActionSheetItem[] = [
    ...(phone
      ? [
          {
            key: 'call',
            label: t('actions.call'),
            icon: <Phone className="size-4" />,
            onSelect: () => {
              window.location.href = `tel:${phone.replace(/\s/g, '')}`;
            },
          } satisfies ActionSheetItem,
        ]
      : []),
    {
      key: 'sheet',
      label: t('sheet.title'),
      icon: <User className="size-4" />,
      onSelect: () => onSelect(customer.customerId),
    },
    {
      key: 'orders',
      label: t('actions.orders'),
      icon: <Package className="size-4" />,
      onSelect: () =>
        router.push(
          phone
            ? `/s/${storeId}/commandes?q=${encodeURIComponent(phone)}`
            : `/s/${storeId}/commandes`,
        ),
    },
  ];

  return (
    <ResourceRow
      meta={<ClientMeta customer={customer} />}
      onActivate={() => onSelect(customer.customerId)}
      overflow={
        <ActionSheet
          align="end"
          items={overflowItems}
          title={name}
          trigger={
            <button
              aria-label={`${t('actions.more')} — ${name}`}
              className="inline-flex size-12 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
            >
              <MoreHorizontal aria-hidden="true" className="size-4" />
            </button>
          }
        />
      }
      primaryAction={
        phone ? (
          <a
            aria-label={`${t('actions.whatsapp')} — ${name}`}
            className="inline-flex size-12 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            href={toWhatsAppLink(phone)}
            rel="noreferrer"
            target="_blank"
          >
            <MessageCircle aria-hidden="true" className="size-4" />
          </a>
        ) : null
      }
      status={
        <span title={customer.isProvisional ? t('score.provisional') : undefined}>
          <StatusBadge label={tierLabel} tone={tierToTone(customer.tier)} />
        </span>
      }
      title={name}
    />
  );
}

// ── Fiche client (intacte — migration vers DetailPanel = ticket séparé) ─────

function DetailActionBar({
  customer,
  storeId,
}: {
  customer: CustomerDetail;
  storeId: string;
}) {
  const t = useTranslations('clients');
  const phone = customer.phone;
  const canCall = Boolean(phone);

  return (
    <div className="grid grid-cols-2 gap-2">
      <a
        aria-disabled={!canCall}
        className={cn(
          'inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium',
          canCall ? 'bg-surface text-text hover:bg-canvas' : 'pointer-events-none text-muted',
        )}
        href={phone ? `tel:${phone.replace(/\s/g, '')}` : undefined}
      >
        <Phone aria-hidden="true" className="size-4" />
        {t('actions.call')}
      </a>
      <a
        aria-disabled={!canCall}
        className={cn(
          'inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium',
          canCall ? 'bg-surface text-text hover:bg-canvas' : 'pointer-events-none text-muted',
        )}
        href={phone ? toWhatsAppLink(phone) : undefined}
        rel="noreferrer"
        target="_blank"
      >
        <MessageCircle aria-hidden="true" className="size-4" />
        {t('actions.whatsapp')}
      </a>
      {customer.tier === 'watch' ? (
        <Button
          className="min-h-12"
          disabled
          title={t('actions.requestConfirmationSoon')}
          type="button"
          variant="secondary"
        >
          {t('actions.requestConfirmation')}
        </Button>
      ) : null}
      {customer.tier === 'risk' ? (
        <Button
          className="min-h-12"
          disabled
          title={t('actions.depositSoon')}
          type="button"
          variant="secondary"
        >
          {t('actions.deposit')}
        </Button>
      ) : null}
      {customer.tier === 'risk' ? (
        <Button
          className="min-h-12"
          disabled
          title={t('actions.noteSoon')}
          type="button"
          variant="secondary"
        >
          {t('actions.addNote')}
        </Button>
      ) : null}
      <Link
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent-hover"
        href={
          phone
            ? `/s/${storeId}/commandes?q=${encodeURIComponent(phone)}`
            : `/s/${storeId}/commandes`
        }
      >
        {t('actions.orders')}
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    </div>
  );
}

function CustomerSheet({
  customer,
  loading,
  onClose,
  storeId,
}: {
  customer: CustomerDetail | null;
  loading: boolean;
  onClose: () => void;
  storeId: string;
}) {
  const t = useTranslations('clients');
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      <motion.div
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-50 flex justify-end overflow-hidden bg-black/40"
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        onClick={onClose}
      >
        <motion.dialog
          animate={{ x: 0 }}
          aria-modal="true"
          className="relative m-0 flex h-dvh max-h-dvh min-h-0 w-full flex-col overflow-hidden border-0 bg-surface p-0 shadow-2 outline-none sm:max-w-[520px]"
          exit={{ x: reduceMotion ? 0 : '100%' }}
          initial={{ x: reduceMotion ? 0 : '100%' }}
          onClick={(event) => event.stopPropagation()}
          open
          transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.2, 0, 0, 1] }}
        >
          <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
            <div>
              <p className="text-sm font-medium text-muted">{t('sheet.title')}</p>
              <h2 className="mt-1 text-xl font-semibold">
                {customer ? customerName(customer, t('fallbackName')) : t('loading')}
              </h2>
            </div>
            <button
              aria-label={t('sheet.close')}
              className="inline-flex size-12 shrink-0 items-center justify-center rounded-lg hover:bg-canvas"
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {loading ? (
              <div className="space-y-3">
                <div className="h-28 animate-pulse rounded-lg bg-canvas" />
                <div className="h-48 animate-pulse rounded-lg bg-canvas" />
              </div>
            ) : null}

            {!loading && customer ? (
              <div className="space-y-6">
                <section className="rounded-lg border border-border bg-canvas p-4">
                  <TierBadge isProvisional={customer.isProvisional} tier={customer.tier} />
                  <p className="mt-3 text-sm text-muted">{t(`advice.${customer.actionsKey}`)}</p>
                  <div className="mt-3">
                    <CustomerBadges customer={customer} />
                  </div>
                  {customer.isProvisional ? (
                    <p className="mt-3 text-xs text-muted">{t('score.provisional')}</p>
                  ) : null}
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('contact.title')}</h3>
                  <div className="rounded-lg border border-border bg-canvas p-3 text-sm">
                    <p className="text-xs text-muted">
                      {customer.phone ? formatPhoneSN(customer.phone) : t('fallbackPhone')}
                    </p>
                    <p className="mt-2 flex items-start gap-2">
                      <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                      <span className={customer.addressText ? undefined : 'text-muted'}>
                        {customer.addressText ?? t('contact.noAddress')}
                      </span>
                    </p>
                  </div>
                </section>

                {(customer.flags.confirmsThenRefuses ||
                  customer.flags.hardToReach ||
                  customer.flags.cancelsOften) && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-semibold">{t('flags.title')}</h3>
                    <div className="space-y-2">
                      {customer.flags.confirmsThenRefuses ? (
                        <p className="rounded-lg border border-danger/25 bg-danger-subtle p-3 text-sm text-danger">
                          {t('flags.confirmsThenRefuses')}
                        </p>
                      ) : null}
                      {customer.flags.hardToReach ? (
                        <p className="rounded-lg border border-border bg-canvas p-3 text-sm text-muted">
                          {t('flags.hardToReach')}
                        </p>
                      ) : null}
                      {customer.flags.cancelsOften ? (
                        <p className="rounded-lg border border-border bg-canvas p-3 text-sm text-muted">
                          {t('flags.cancelsOften')}
                        </p>
                      ) : null}
                    </div>
                  </section>
                )}

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('actions.title')}</h3>
                  <DetailActionBar customer={customer} storeId={storeId} />
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    {t('history.title')}
                    {customer.hasMoreHistory && (
                      <span className="ml-2 font-normal text-muted">
                        — 30 les plus récentes affichées
                      </span>
                    )}
                  </h3>
                  {customer.history.length > 0 ? (
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {customer.history.map((order) => (
                        <Link
                          className="block p-3 hover:bg-canvas"
                          href={`/s/${storeId}/commandes/${order.id}`}
                          key={order.id}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-mono text-sm font-semibold tabular-nums">
                                {order.order_number ?? t('history.orderFallback')}
                              </p>
                              <p className="mt-1 text-xs text-muted">
                                {formatDateRelative(order.created_at_shopify ?? order.created_at)}
                              </p>
                            </div>
                            {isOrderStatus(order.cod_status) ? (
                              <CodStatusBadge status={order.cod_status} />
                            ) : null}
                          </div>
                          <p className="mt-2 text-sm font-semibold">
                            <Amount amountMinor={order.total_amount} className="font-mono" />
                          </p>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg border border-border bg-canvas p-4 text-sm text-muted">
                      {t('history.empty')}
                    </p>
                  )}
                </section>

                <section className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted">{t('stats.orders')}</p>
                    <p className="font-mono text-lg font-semibold tabular-nums">
                      {customer.orderCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted">{t('stats.deliveredCount')}</p>
                    <p className="font-mono text-lg font-semibold tabular-nums">
                      {customer.deliveredCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted">{t('stats.refused')}</p>
                    <p
                      className={cn(
                        'font-mono text-lg font-semibold tabular-nums',
                        customer.isRefuser ? 'text-danger' : undefined,
                      )}
                    >
                      {customer.refusedCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted">{t('stats.cancelled')}</p>
                    <p className="font-mono text-lg font-semibold tabular-nums">
                      {customer.cancelledCount}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted">{t('stats.delivered')}</p>
                    <p className="text-sm font-semibold">
                      <Amount amountMinor={customer.deliveredLifetime} className="font-mono" />
                    </p>
                  </div>
                </section>
              </div>
            ) : null}
          </div>
        </motion.dialog>
      </motion.div>
    </AnimatePresence>
  );
}

// ── Workspace principal ─────────────────────────────────────────────────────

// Consomme le plafond déjà supporté par listCustomersSchema (limit max 100,
// offset) — jamais consommé côté UI avant ce lot (troncature silencieuse au
// delà de 50 clients, U0-D2 P0 §8).
const CLIENTS_PAGE_SIZE = 100;

export function ClientsWorkspace({ storeId }: { storeId: string }) {
  const t = useTranslations('clients');
  const reduceMotion = useReducedMotion();
  const listCustomers = useAction(listCustomersAction);
  const getCustomer = useAction(getCustomerAction);
  const [search, setSearch] = useState('');
  const [sortByRisk, setSortByRisk] = useState(true);
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const loading = listCustomers.isExecuting && !initialLoadDone;
  // Compteur de génération : une sélection A puis B (avant résolution de A) ne
  // doit jamais laisser la réponse de A écraser B (course U0-D2 §7/§8).
  const selectionRequestIdRef = useRef(0);

  useEffect(() => {
    setInitialLoadDone(false);
    const timeoutId = window.setTimeout(async () => {
      const result = await listCustomers.executeAsync({
        search,
        shopId: storeId,
        sortByRisk,
        limit: CLIENTS_PAGE_SIZE,
        offset: 0,
      });
      setInitialLoadDone(true);
      if (result?.data?.ok) {
        setCustomers(result.data.customers);
        setHasMore(result.data.customers.length === CLIENTS_PAGE_SIZE);
        setOffset(0);
      }
    }, 280);

    return () => window.clearTimeout(timeoutId);
  }, [listCustomers.executeAsync, search, sortByRisk, storeId]);

  async function loadMoreCustomers() {
    const nextOffset = offset + CLIENTS_PAGE_SIZE;
    setIsLoadingMore(true);
    const result = await listCustomers.executeAsync({
      search,
      shopId: storeId,
      sortByRisk,
      limit: CLIENTS_PAGE_SIZE,
      offset: nextOffset,
    });
    setIsLoadingMore(false);
    if (result?.data?.ok) {
      const newCustomers = result.data.customers;
      setCustomers((prev) => [...prev, ...newCustomers]);
      setHasMore(newCustomers.length === CLIENTS_PAGE_SIZE);
      setOffset(nextOffset);
    }
  }

  async function selectCustomer(customerId: string) {
    const requestId = ++selectionRequestIdRef.current;
    setSelectedCustomerId(customerId);
    setSelectedCustomer(null);
    setDetailLoading(true);
    setFeedback(null);

    const result = await getCustomer.executeAsync({ customerId, shopId: storeId });

    if (selectionRequestIdRef.current !== requestId) {
      // Une sélection plus récente a déjà démarré — cette réponse est
      // obsolète, ne jamais l'appliquer (course U0-D2 §7/§8).
      return;
    }

    setDetailLoading(false);

    if (result?.data?.ok) {
      setSelectedCustomer(result.data.customer);
      return;
    }

    setFeedback({ tone: 'error', message: t('errors.detail') });
  }

  const empty = !loading && customers.length === 0;
  const motionProps = useMemo(
    () => ({
      animate: { opacity: 1, y: 0 },
      initial: { opacity: 0, y: reduceMotion ? 0 : 8 },
      transition: { duration: reduceMotion ? 0 : 0.22 },
    }),
    [reduceMotion],
  );

  return (
    <main className="space-y-6" id="main">
      <PageHeader
        search={
          <div className="space-y-2">
            <SearchInput
              ariaLabel={t('search.label')}
              clearLabel={t('search.clear')}
              onValueChange={setSearch}
              placeholder={t('search.placeholder')}
              syncUrl={false}
              value={search}
            />
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
              <input
                checked={sortByRisk}
                className="size-4 accent-accent"
                onChange={(event) => setSortByRisk(event.target.checked)}
                type="checkbox"
              />
              {t('search.sortByRisk')}
            </label>
          </div>
        }
        size="display"
        subtitle={t('subtitle')}
        title={t('title')}
      />

      {feedback ? (
        <output className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm font-medium text-danger">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4" />
          {feedback.message}
        </output>
      ) : null}

      {listCustomers.result.data && !listCustomers.result.data.ok ? (
        <div className="rounded-lg border border-danger/30 bg-danger-subtle p-4 text-sm font-medium text-danger">
          {t('errors.list')}
        </div>
      ) : null}

      {loading ? (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {skeletonIds.map((skeletonId) => (
            <ResourceRowSkeleton key={skeletonId} />
          ))}
        </div>
      ) : null}

      {empty ? <EmptyState title={t('empty')} /> : null}

      {!loading && customers.length > 0 ? (
        <motion.div
          className="overflow-hidden rounded-lg border border-border bg-surface"
          {...motionProps}
        >
          {customers.map((customer) => (
            <ClientRow
              customer={customer}
              key={customer.customerId}
              onSelect={selectCustomer}
              storeId={storeId}
            />
          ))}
        </motion.div>
      ) : null}

      {!loading && hasMore ? (
        <div className="flex justify-center">
          <button
            className="min-h-12 rounded-lg border border-border bg-surface px-6 text-sm font-medium text-text hover:bg-canvas disabled:opacity-60"
            disabled={isLoadingMore}
            onClick={loadMoreCustomers}
            type="button"
          >
            {isLoadingMore ? 'Chargement…' : 'Voir plus'}
          </button>
        </div>
      ) : null}

      {selectedCustomerId ? (
        <CustomerSheet
          customer={selectedCustomer}
          loading={detailLoading}
          onClose={() => {
            setSelectedCustomerId(null);
            setSelectedCustomer(null);
          }}
          storeId={storeId}
        />
      ) : null}
    </main>
  );
}

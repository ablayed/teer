'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet';
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
import { formatMoney } from '@/lib/format/fcfa';
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
import { useEffect, useMemo, useState } from 'react';

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

function ScoreValue({ customer }: { customer: Pick<CustomerListItem, 'score' | 'tier'> }) {
  const t = useTranslations('clients');

  if (customer.tier === 'new') {
    return <span className="text-sm text-muted">{t('score.hidden')}</span>;
  }

  return <span className="font-mono text-2xl font-semibold tabular-nums">{customer.score}</span>;
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
        {formatMoney(customer.deliveredLifetime)}
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
}: {
  customer: CustomerListItem;
  onSelect: (customerId: string) => void;
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
      onSelect: () => router.push('/commandes'),
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
              className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-canvas hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
}: {
  customer: CustomerDetail;
}) {
  const t = useTranslations('clients');
  const phone = customer.phone;
  const canCall = Boolean(phone);

  return (
    <div className="grid grid-cols-2 gap-2">
      <a
        aria-disabled={!canCall}
        className={cn(
          'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium',
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
          'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium',
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
        <Button className="min-h-11" type="button" variant="secondary">
          {t('actions.requestConfirmation')}
        </Button>
      ) : null}
      {customer.tier === 'risk' ? (
        <Button
          className="min-h-11"
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
          className="min-h-11"
          disabled
          title={t('actions.noteSoon')}
          type="button"
          variant="secondary"
        >
          {t('actions.addNote')}
        </Button>
      ) : null}
      <Link
        className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent-hover"
        href="/commandes"
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
}: {
  customer: CustomerDetail | null;
  loading: boolean;
  onClose: () => void;
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
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-canvas"
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
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <TierBadge isProvisional={customer.isProvisional} tier={customer.tier} />
                      <p className="mt-3 text-sm text-muted">
                        {t(`advice.${customer.actionsKey}`)}
                      </p>
                    </div>
                    <div className="text-right">
                      <ScoreValue customer={customer} />
                      {customer.tier !== 'new' ? (
                        <p className="text-xs text-muted">{t('score.label')}</p>
                      ) : null}
                    </div>
                  </div>
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
                    {customer.tags && customer.tags.length > 0 ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {customer.tags.map((tag) => (
                          <span
                            className="inline-flex items-center rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-muted"
                            key={tag}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
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
                  <DetailActionBar customer={customer} />
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">{t('history.title')}</h3>
                  {customer.history.length > 0 ? (
                    <div className="divide-y divide-border rounded-lg border border-border">
                      {customer.history.map((order) => (
                        <Link
                          className="block p-3 hover:bg-canvas"
                          href={`/commandes/${order.id}`}
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
                          <p className="mt-2 font-mono text-sm font-semibold tabular-nums">
                            {formatMoney(order.total_amount)}
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

                <section className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs text-muted">{t('stats.orders')}</p>
                    <p className="font-mono text-lg font-semibold tabular-nums">
                      {customer.orderCount}
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
                    <p className="font-mono text-sm font-semibold tabular-nums">
                      {formatMoney(customer.deliveredLifetime)}
                    </p>
                  </div>
                  {customer.shopifyOrdersCount !== null ? (
                    <div className="rounded-lg border border-border p-3">
                      <p className="text-xs text-muted">{t('stats.shopifyOrders')}</p>
                      <p className="font-mono text-lg font-semibold tabular-nums">
                        {customer.shopifyOrdersCount}
                      </p>
                    </div>
                  ) : null}
                  {customer.shopifyAmountSpentMinor !== null ? (
                    <div className="rounded-lg border border-border p-3">
                      <p className="text-xs text-muted">{t('stats.shopifySpent')}</p>
                      <p className="font-mono text-sm font-semibold tabular-nums">
                        {formatMoney(customer.shopifyAmountSpentMinor)}
                      </p>
                    </div>
                  ) : null}
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

export function ClientsWorkspace() {
  const t = useTranslations('clients');
  const reduceMotion = useReducedMotion();
  const listCustomers = useAction(listCustomersAction);
  const getCustomer = useAction(getCustomerAction);
  const [search, setSearch] = useState('');
  const [sortByRisk, setSortByRisk] = useState(true);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const listData = listCustomers.result.data?.ok ? listCustomers.result.data : null;
  const customers = listData?.customers ?? [];
  const loading = listCustomers.isExecuting && !listData;

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      listCustomers.execute({ search, sortByRisk });
    }, 280);

    return () => window.clearTimeout(timeoutId);
  }, [listCustomers.execute, search, sortByRisk]);

  async function selectCustomer(customerId: string) {
    setSelectedCustomerId(customerId);
    setSelectedCustomer(null);
    setDetailLoading(true);
    setFeedback(null);

    const result = await getCustomer.executeAsync({ customerId });
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
            <ClientRow customer={customer} key={customer.customerId} onSelect={selectCustomer} />
          ))}
        </motion.div>
      ) : null}

      {selectedCustomerId ? (
        <CustomerSheet
          customer={selectedCustomer}
          loading={detailLoading}
          onClose={() => {
            setSelectedCustomerId(null);
            setSelectedCustomer(null);
          }}
        />
      ) : null}
    </main>
  );
}

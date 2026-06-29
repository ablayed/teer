'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { SearchInput } from '@/components/ui/search-input';
import { ResourceRowSkeleton } from '@/components/ui/skeleton';
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
  Phone,
  Repeat,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type Feedback = {
  message: string;
  tone: 'error' | 'success';
};

const tierStyles: Record<ReliabilityTier, string> = {
  new: 'border-border bg-canvas text-muted',
  reliable: 'border-success bg-success text-white',
  watch: 'border-accent bg-accent text-accent-ink',
  risk: 'border-danger bg-danger text-white',
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

function CustomerCard({
  customer,
  onSelect,
}: {
  customer: CustomerListItem;
  onSelect: (customerId: string) => void;
}) {
  const t = useTranslations('clients');

  return (
    <button
      className="group w-full rounded-lg border border-border bg-surface p-4 text-left shadow-1 transition hover:-translate-y-0.5 hover:shadow-2 focus:outline-none focus:ring-2 focus:ring-accent"
      onClick={() => onSelect(customer.customerId)}
      type="button"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{customerName(customer, t('fallbackName'))}</p>
          <p className="mt-1 text-sm text-muted">
            {customer.phone ? formatPhoneSN(customer.phone) : t('fallbackPhone')}
          </p>
          <div className="mt-2">
            <CustomerBadges customer={customer} />
          </div>
        </div>
        <TierBadge isProvisional={customer.isProvisional} tier={customer.tier} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-xs text-muted">{t('list.score')}</p>
          <ScoreValue customer={customer} />
        </div>
        <div>
          <p className="text-xs text-muted">{t('list.delivered')}</p>
          <p className="font-mono font-semibold tabular-nums">
            {formatMoney(customer.deliveredLifetime)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted">{t('list.orders')}</p>
          <p className="font-mono font-semibold tabular-nums">{customer.orderCount}</p>
        </div>
      </div>
    </button>
  );
}

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
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          {...motionProps}
          variants={{
            visible: { transition: { staggerChildren: reduceMotion ? 0 : 0.04 } },
          }}
        >
          {customers.map((customer) => (
            <motion.div key={customer.customerId} {...motionProps}>
              <CustomerCard customer={customer} onSelect={selectCustomer} />
            </motion.div>
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

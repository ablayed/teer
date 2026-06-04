'use client';

import { CallLogForm } from '@/components/orders/call-log-form';
import { DeliveryAddressForm } from '@/components/orders/delivery-address-form';
import {
  type DriverOption,
  type PayloadDialogAction,
  TransitionDialog,
  type TransitionPayload,
} from '@/components/orders/transition-dialog';
import { WhatsAppConfirmButton } from '@/components/orders/whatsapp-confirm-button';
import { Button } from '@/components/ui/button';
import type { OrderDetail, OrderTimelineEvent } from '@/lib/actions/orders';
import { performTransition } from '@/lib/actions/transitions';
import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import type { TransitionAction } from '@/lib/domain/order-transition-actions';
import { formatDateTime } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import { formatPhoneSN } from '@/lib/format/phone';
import type { Json } from '@/lib/supabase/database.types';
import { cn } from '@/lib/utils';
import { buildWhatsAppConfirmationUrl, firstName } from '@/lib/whatsapp/link';
import {
  ArrowLeft,
  CheckCircle2,
  Clock3,
  MapPin,
  Phone,
  ShoppingBag,
  Truck,
  X,
} from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type OrderDetailPanelProps = {
  drivers: DriverOption[];
  mode: 'page' | 'sheet';
  onClose?: () => void;
  order: OrderDetail;
  shopName: string;
  timeline: OrderTimelineEvent[];
  whatsappLabels: {
    confirm: string;
    missingPhone: string;
  };
};

// Actions that need an extra input collected via a dialog before running.
function isPayloadDialogAction(action: TransitionAction): action is PayloadDialogAction {
  return action === 'assigner' || action === 'programmer';
}

type ShippingAddress = {
  address1: string | null;
  address2: string | null;
  city: string | null;
  country: string | null;
  province: string | null;
  zip: string | null;
};

type ItemSummary = {
  price: number;
  quantity: number;
  title: string;
};

type TransitionButtonConfig = {
  label: string;
  action: TransitionAction;
  tone: 'primary' | 'secondary' | 'accent' | 'destructive';
};

const transitionButtonConfigs: Record<TransitionAction, TransitionButtonConfig> = {
  journaliser_appel: {
    action: 'journaliser_appel',
    label: 'Journaliser une tentative',
    tone: 'secondary',
  },
  confirmer: { action: 'confirmer', label: 'Confirmer', tone: 'primary' },
  programmer: { action: 'programmer', label: 'Programmer la livraison', tone: 'primary' },
  assigner: { action: 'assigner', label: 'Assigner', tone: 'primary' },
  livrer: { action: 'livrer', label: 'Marquer livree', tone: 'accent' },
  annuler: { action: 'annuler', label: 'Annuler la commande', tone: 'destructive' },
  refuser: { action: 'refuser', label: 'Refuser', tone: 'secondary' },
};

const primaryActionOrder: TransitionAction[] = [
  'journaliser_appel',
  'confirmer',
  'programmer',
  'assigner',
  'livrer',
  'refuser',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parseShippingAddress(value: Json | null): ShippingAddress | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    address1: stringField(value, 'address1'),
    address2: stringField(value, 'address2'),
    city: stringField(value, 'city'),
    country: stringField(value, 'country'),
    province: stringField(value, 'province'),
    zip: stringField(value, 'zip'),
  };
}

function parseItemsSummary(value: Json | null): ItemSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: ItemSummary[] = [];

  for (const item of value) {
    if (isRecord(item)) {
      items.push({
        title: stringField(item, 'title') ?? '',
        quantity: numberField(item, 'quantity'),
        price: numberField(item, 'price'),
      });
    }
  }

  return items;
}

function formatAddress(address: ShippingAddress | null, emptyValue: string): string {
  if (!address) {
    return emptyValue;
  }

  const parts = [
    address.address1,
    address.address2,
    address.city,
    address.province,
    address.country,
    address.zip,
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(', ') : emptyValue;
}

function toOrderStatus(value: string): OrderStatus {
  return Object.hasOwn(orderStatusLabels, value) ? (value as OrderStatus) : 'A_APPELER';
}

function shortActorId(actorUserId: string): string {
  return actorUserId.slice(0, 8);
}

function Timeline({
  currentStatus,
  events,
}: { currentStatus: OrderStatus; events: OrderTimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted">Aucun historique.</p>;
  }

  return (
    <ol className="relative space-y-4 border-l border-border pl-4">
      {events.map((event) => {
        const isCurrentTransition = event.type === 'transition' && event.toStatus === currentStatus;

        return (
          <li className="relative" key={`${event.type}-${event.id}`}>
            <span
              className={cn(
                '-left-[21px] absolute mt-1 flex size-3 rounded-full border-2 border-surface',
                isCurrentTransition ? 'bg-accent' : 'bg-muted',
              )}
            />
            <div className="space-y-1">
              <p className="text-sm font-semibold">
                {event.type === 'transition'
                  ? `${event.fromStatus ? orderStatusLabels[event.fromStatus] : 'Initial'} -> ${
                      orderStatusLabels[event.toStatus]
                    }`
                  : `Appel - ${event.outcome.replace(/_/g, ' ')}`}
              </p>
              <p className="text-xs text-muted">
                {formatDateTime(event.createdAt)} · {shortActorId(event.actorUserId)}
              </p>
              {event.note ? <p className="text-sm text-muted">{event.note}</p> : null}
              {event.type === 'call' && event.nextActionAt ? (
                <p className="text-xs font-medium text-text">
                  Rappel: {formatDateTime(event.nextActionAt)}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function ActionBar({
  allowedActions,
  drivers,
  onAllowedActionsChange,
  onStatusChange,
  orderId,
}: {
  allowedActions: TransitionAction[];
  drivers: DriverOption[];
  onAllowedActionsChange: (actions: TransitionAction[]) => void;
  onStatusChange: (status: OrderStatus) => void;
  orderId: string;
}) {
  const router = useRouter();
  const transitionStatus = useAction(performTransition);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PayloadDialogAction | null>(null);
  const visibleTransitions = primaryActionOrder
    .filter((action) => allowedActions.includes(action))
    .map((action) => transitionButtonConfigs[action]);
  const canCancel = allowedActions.includes('annuler');

  function executeTransition(action: TransitionAction) {
    setFeedback(null);

    if (isPayloadDialogAction(action)) {
      setPendingAction(action);
      return;
    }

    transitionStatus.execute({ orderId, action });
  }

  function handleDialogConfirm(payload: TransitionPayload) {
    if (!pendingAction) {
      return;
    }

    transitionStatus.execute({ orderId, action: pendingAction, payload });
    setPendingAction(null);
  }

  useEffect(() => {
    const result = transitionStatus.result.data;

    if (!result) {
      return;
    }

    if (result.ok) {
      onStatusChange(toOrderStatus(result.order.cod_status));
      onAllowedActionsChange(result.allowedActions);
      setFeedback('Statut COD mis a jour.');
      router.refresh();
      return;
    }

    setFeedback('message' in result ? result.message : 'La mise a jour du statut a echoue.');
  }, [onAllowedActionsChange, onStatusChange, router, transitionStatus.result.data]);

  if (allowedActions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-medium text-muted">
        Aucune action disponible
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {visibleTransitions.map((transition) => (
          <Button
            className={cn(
              transition.tone === 'secondary' && 'border border-border bg-surface text-text',
              transition.tone === 'accent' && 'bg-[#EE8243] text-[#111] hover:bg-[#f09a66]',
            )}
            disabled={transitionStatus.isExecuting}
            key={transition.action}
            onClick={() => executeTransition(transition.action)}
            size="sm"
            variant={transition.tone === 'primary' ? 'primary' : 'ghost'}
          >
            {transition.label}
          </Button>
        ))}
      </div>
      {canCancel ? (
        <div className="border-t border-border pt-3">
          <Button
            className="w-full border border-danger/30 bg-red-50 text-danger hover:bg-red-100 sm:w-auto"
            disabled={transitionStatus.isExecuting}
            onClick={() => executeTransition('annuler')}
            size="sm"
            variant="ghost"
          >
            {transitionButtonConfigs.annuler.label}
          </Button>
        </div>
      ) : null}
      {feedback ? (
        <output className="rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-muted shadow-1">
          {feedback}
        </output>
      ) : null}
      {pendingAction ? (
        <TransitionDialog
          action={pendingAction}
          drivers={drivers}
          isSubmitting={transitionStatus.isExecuting}
          onCancel={() => setPendingAction(null)}
          onConfirm={handleDialogConfirm}
        />
      ) : null}
    </div>
  );
}

export function OrderDetailPanel({
  drivers,
  mode,
  onClose,
  order,
  shopName,
  timeline,
  whatsappLabels,
}: OrderDetailPanelProps) {
  const [visibleTimeline, setVisibleTimeline] = useState(timeline);
  const [optimisticStatus, setOptimisticStatus] = useState<OrderStatus>(() =>
    toOrderStatus(order.cod_status),
  );
  const [allowedActions, setAllowedActions] = useState<TransitionAction[]>(order.allowedActions);
  const emptyValue = 'Non renseigne';
  const currentStatus = optimisticStatus;
  const shippingAddress = parseShippingAddress(order.shipping_address);
  const structuredAddress = order.delivery_address ?? order.customer_delivery_address;
  const items = parseItemsSummary(order.items_summary);
  const phone = order.customer?.phone ?? null;
  const fallbackQuartier = [shippingAddress?.address1, shippingAddress?.address2]
    .filter(Boolean)
    .join(', ');
  const formattedDeliveryAddress = formatAddress(shippingAddress, emptyValue);
  const whatsappUrl = buildWhatsAppConfirmationUrl({
    address: formattedDeliveryAddress === emptyValue ? null : formattedDeliveryAddress,
    currency: order.currency,
    customerFirstName: firstName(order.customer?.full_name),
    itemsSummary: order.items_summary,
    orderNumber: order.order_number,
    phone,
    shopName,
    totalAmount: order.total_amount,
  });
  const contentClassName =
    mode === 'sheet'
      ? 'flex h-full min-h-0 w-full flex-col'
      : 'mx-auto max-w-5xl space-y-6 px-4 py-6';
  const actionBar = (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase text-muted">Actions</h2>
      <ActionBar
        allowedActions={allowedActions}
        drivers={drivers}
        onAllowedActionsChange={setAllowedActions}
        onStatusChange={setOptimisticStatus}
        orderId={order.id}
      />
    </section>
  );

  useEffect(() => {
    setVisibleTimeline(timeline);
  }, [timeline]);

  useEffect(() => {
    setOptimisticStatus(toOrderStatus(order.cod_status));
    setAllowedActions(order.allowedActions);
  }, [order.allowedActions, order.cod_status]);

  return (
    <div className={contentClassName}>
      <header
        className={cn(
          'flex shrink-0 items-start justify-between gap-4 border-b border-border bg-surface p-5',
          mode === 'page' && 'rounded-lg border shadow-1',
        )}
      >
        <div className="min-w-0 space-y-1">
          <p className="font-mono text-sm font-semibold text-muted">
            {order.order_number ?? emptyValue}
          </p>
          <h1 className="truncate text-xl font-semibold">
            {order.customer?.full_name ?? emptyValue}
          </h1>
          <p className="text-sm font-medium text-muted">{orderStatusLabels[currentStatus]}</p>
        </div>
        {mode === 'sheet' ? (
          <button
            aria-label="Fermer"
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-canvas"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        ) : (
          <Link
            className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3 font-medium text-muted hover:bg-canvas hover:text-text"
            href="/commandes"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Retour
          </Link>
        )}
      </header>

      <div
        className={cn(
          'space-y-5 p-5',
          mode === 'sheet' && 'min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8',
        )}
      >
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-muted">Client</h2>
          <div className="space-y-2">
            <p className="text-lg font-semibold">{order.customer?.full_name ?? emptyValue}</p>
            <p className="text-sm text-muted">{phone ? formatPhoneSN(phone) : emptyValue}</p>
            {phone ? (
              <div className="flex flex-wrap gap-2">
                <a
                  className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-canvas"
                  href={`tel:${phone.replace(/\s/g, '')}`}
                >
                  <Phone aria-hidden="true" className="size-4" />
                  Appeler
                </a>
                <WhatsAppConfirmButton
                  disabledLabel={whatsappLabels.missingPhone}
                  label={whatsappLabels.confirm}
                  url={whatsappUrl}
                />
              </div>
            ) : (
              <WhatsAppConfirmButton
                disabledLabel={whatsappLabels.missingPhone}
                label={whatsappLabels.confirm}
                url={null}
              />
            )}
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-muted">Livraison</h2>
          <p className="flex gap-2 text-sm italic leading-6 text-muted">
            <MapPin aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent" />
            {formattedDeliveryAddress}
          </p>
          <DeliveryAddressForm
            fallbackPhone={phone}
            fallbackQuartier={fallbackQuartier || null}
            fallbackVille={shippingAddress?.city}
            initialAddress={structuredAddress}
            orderId={order.id}
          />
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase text-muted">Articles</h2>
          {items.length > 0 ? (
            <div className="divide-y divide-border">
              {items.map((item, index) => (
                <div
                  className="flex items-center justify-between gap-3 py-3"
                  key={`${item.title}-${index}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-accent">
                      <ShoppingBag aria-hidden="true" className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{item.title || emptyValue}</p>
                      <p className="text-xs text-muted">
                        {item.quantity} x {formatMoney(item.price, order.currency)}
                      </p>
                    </div>
                  </div>
                  <p className="shrink-0 text-sm font-semibold">
                    {formatMoney(item.quantity * item.price, order.currency)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Aucun article renseigne.</p>
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted">Total</p>
            <p className="mt-1 text-xl font-semibold">
              {formatMoney(order.total_amount, order.currency)}
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted">Shopify</p>
            <div className="mt-2 space-y-1 text-sm">
              <p className="flex items-center gap-2">
                <CheckCircle2 aria-hidden="true" className="size-4 text-muted" />
                {order.financial_status ?? emptyValue}
              </p>
              <p className="flex items-center gap-2">
                <Truck aria-hidden="true" className="size-4 text-muted" />
                {order.fulfillment_status ?? emptyValue}
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase text-muted">
            <Clock3 aria-hidden="true" className="size-4" />
            Timeline
          </h2>
          <Timeline currentStatus={currentStatus} events={visibleTimeline} />
        </section>

        {mode === 'page' ? actionBar : null}

        <CallLogForm
          onOptimisticCall={(event) =>
            setVisibleTimeline((currentTimeline) => [event, ...currentTimeline])
          }
          onRemoveOptimisticCall={(eventId) =>
            setVisibleTimeline((currentTimeline) =>
              currentTimeline.filter((event) => event.id !== eventId),
            )
          }
          orderId={order.id}
        />
      </div>
      {mode === 'sheet' ? (
        <footer className="shrink-0 border-t border-border bg-surface p-5">{actionBar}</footer>
      ) : null}
    </div>
  );
}

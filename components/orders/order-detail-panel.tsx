'use client';

import { CodStatusBadge, codDisplayLabel } from '@/components/orders/cod-status-badge';
import { DeliveryAddressForm } from '@/components/orders/delivery-address-form';
import { OrderActionsMenu } from '@/components/orders/order-actions-menu';
import { OrderAmountsEditor } from '@/components/orders/order-amounts-editor';
import { OrderCartEditor } from '@/components/orders/order-cart-editor';
import { OrderDriverReassign } from '@/components/orders/order-driver-reassign';
import type { DriverOption } from '@/components/orders/transition-dialog';
import { Button } from '@/components/ui/button';
import type { OrderDetail } from '@/lib/actions/orders';
import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import { cancelReasonLabels, isCancelReason } from '@/lib/domain/order-transition-actions';
import { formatMoney } from '@/lib/format/fcfa';
import { formatPhoneSN } from '@/lib/format/phone';
import { canEditOrderCart } from '@/lib/orders/cart-editing';
import type { Json } from '@/lib/supabase/database.types';
import { cn } from '@/lib/utils';
import { type WhatsappOrderData, parseItemsSummaryForWhatsapp } from '@/lib/whatsapp/format';
import { ArrowLeft, MapPin, Pencil, ShoppingBag, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

type OrderDetailPanelProps = {
  // Phase 11 : édition des montants (total + frais de livraison) réservée
  // owner/manager — masquée à l'agent (qui ne voit pas delivery_fee_minor).
  canEditAmounts: boolean;
  drivers: DriverOption[];
  mode: 'page' | 'sheet';
  onClose?: () => void;
  order: OrderDetail;
};

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

type ShopifyAttributeDisplay = {
  key: string;
  value: string | null;
};

type OrderAttributesDisplay = {
  attributes: ShopifyAttributeDisplay[];
  note: string | null;
};

type LineItemAttributesDisplay = {
  attributes: ShopifyAttributeDisplay[];
  title: string;
};

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

// Attribut clé/valeur générique (note_attributes/customAttributes) — affichage brut uniquement.
function parseAttributeList(value: unknown): ShopifyAttributeDisplay[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const attributes: ShopifyAttributeDisplay[] = [];
  for (const item of value) {
    if (isRecord(item)) {
      const key = stringField(item, 'key');
      if (key) {
        attributes.push({ key, value: stringField(item, 'value') });
      }
    }
  }
  return attributes;
}

function parseOrderAttributes(value: Json | null): OrderAttributesDisplay | null {
  if (!isRecord(value)) {
    return null;
  }

  const note = stringField(value, 'note');
  const attributes = parseAttributeList(value.attributes);

  if (!note && attributes.length === 0) {
    return null;
  }

  return { note, attributes };
}

function parseLineItemAttributes(value: Json | null): LineItemAttributesDisplay[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const lines: LineItemAttributesDisplay[] = [];
  for (const item of value) {
    if (isRecord(item)) {
      const attributes = parseAttributeList(item.attributes);
      if (attributes.length > 0) {
        lines.push({ title: stringField(item, 'title') ?? '', attributes });
      }
    }
  }
  return lines;
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

export function OrderDetailPanel({
  canEditAmounts,
  drivers,
  mode,
  onClose,
  order,
}: OrderDetailPanelProps) {
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const emptyValue = 'Non renseigne';
  const currentStatus = toOrderStatus(order.cod_status);
  const shippingAddress = parseShippingAddress(order.shipping_address);
  const structuredAddress = order.delivery_address ?? order.customer_delivery_address;
  const items = parseItemsSummary(order.items_summary);
  const orderAttributes = parseOrderAttributes(order.shopify_order_attributes);
  const lineItemAttributes = parseLineItemAttributes(order.shopify_line_item_attributes);
  const hasAdditionalDetails = orderAttributes !== null || lineItemAttributes.length > 0;
  const phone = order.customer?.phone ?? null;
  const fallbackQuartier = [shippingAddress?.address1, shippingAddress?.address2]
    .filter(Boolean)
    .join(', ');
  const formattedDeliveryAddress = formatAddress(shippingAddress, emptyValue);
  const whatsappOrderData: WhatsappOrderData = {
    numeroCommande: order.order_number,
    telephone: phone,
    adresse: formattedDeliveryAddress === emptyValue ? null : formattedDeliveryAddress,
    total: order.total_amount,
    items: parseItemsSummaryForWhatsapp(order.items_summary),
  };
  const isCancelled = order.order_state === 'cancelled';
  const canEditCart =
    canEditAmounts &&
    canEditOrderCart({ cashState: order.cash_state, deliveryState: order.delivery_state });
  // Lot B : raisons d'annulation multiples (libellés FR), fallback legacy.
  const cancelReasonsDisplay = (order.cancel_reasons ?? [])
    .map((reason) => (isCancelReason(reason) ? cancelReasonLabels[reason] : reason.trim()))
    .filter((label) => label.length > 0);
  const contentClassName =
    mode === 'sheet'
      ? 'flex h-full min-h-0 w-full flex-col'
      : 'mx-auto max-w-5xl space-y-6 px-4 py-6';

  const actionsMenu = (
    <OrderActionsMenu
      allowedActions={order.allowedActions}
      canEditAmounts={canEditAmounts}
      deliveryState={order.delivery_state}
      drivers={drivers}
      orderId={order.id}
      orderState={order.order_state}
      phone={phone}
      whatsappOrderData={whatsappOrderData}
    />
  );

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
          <p className="text-sm font-medium text-muted">
            {codDisplayLabel(currentStatus, order.delivery_state)}
          </p>
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
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase text-muted">Client</h2>
          <p className="text-lg font-semibold">{order.customer?.full_name ?? emptyValue}</p>
          <p className="text-sm text-muted">{phone ? formatPhoneSN(phone) : emptyValue}</p>
        </section>

        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase text-muted">Adresse de livraison</h2>
            <Button
              className="min-h-10"
              onClick={() => setIsEditingAddress((value) => !value)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Pencil aria-hidden="true" className="mr-1 size-4" />
              {isEditingAddress ? 'Fermer' : "Modifier l'adresse"}
            </Button>
          </div>
          <p className="flex gap-2 text-sm italic leading-6 text-muted">
            <MapPin aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent" />
            {formattedDeliveryAddress}
          </p>
          {isEditingAddress ? (
            <DeliveryAddressForm
              fallbackPhone={phone}
              fallbackQuartier={fallbackQuartier || null}
              fallbackVille={shippingAddress?.city}
              initialAddress={structuredAddress}
              orderId={order.id}
            />
          ) : null}
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

        {hasAdditionalDetails ? (
          <section className="space-y-3" data-testid="order-additional-details">
            <h2 className="text-sm font-semibold uppercase text-muted">Détails supplémentaires</h2>
            {orderAttributes?.note ? (
              <p className="text-sm text-text">
                <span className="font-medium">Note : </span>
                {orderAttributes.note}
              </p>
            ) : null}
            {orderAttributes && orderAttributes.attributes.length > 0 ? (
              <dl className="space-y-1">
                {orderAttributes.attributes.map((attribute, index) => (
                  <div className="flex gap-2 text-sm" key={`${attribute.key}-${index}`}>
                    <dt className="font-medium text-muted">{attribute.key} :</dt>
                    <dd className="text-text">{attribute.value ?? '—'}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {lineItemAttributes.map((line, lineIndex) => (
              <div className="space-y-1" key={`${line.title}-${lineIndex}`}>
                <p className="text-sm font-medium">{line.title || emptyValue}</p>
                <dl className="space-y-1 pl-3">
                  {line.attributes.map((attribute, index) => (
                    <div className="flex gap-2 text-sm" key={`${attribute.key}-${index}`}>
                      <dt className="font-medium text-muted">{attribute.key} :</dt>
                      <dd className="text-text">{attribute.value ?? '—'}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </section>
        ) : null}

        {canEditCart ? <OrderCartEditor currency={order.currency} orderId={order.id} /> : null}

        {canEditAmounts ? (
          <OrderAmountsEditor
            currency={order.currency}
            deliveryFeeMinor={order.delivery_fee_minor}
            deliveryState={order.delivery_state}
            orderId={order.id}
            scheduledFor={order.scheduled_for}
            totalAmount={order.total_amount}
          />
        ) : (
          <section className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted">Total</p>
            <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
              {formatMoney(order.total_amount, order.currency)}
            </p>
          </section>
        )}

        <section className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted">Statut COD</p>
          <div className="mt-2">
            <CodStatusBadge deliveryState={order.delivery_state} status={currentStatus} />
          </div>
        </section>

        {canEditAmounts ? (
          <OrderDriverReassign
            currentDriverId={order.assigned_driver_id}
            deliveryState={order.delivery_state}
            drivers={drivers}
            orderId={order.id}
          />
        ) : null}

        {isCancelled ? (
          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted">
              {cancelReasonsDisplay.length > 1 ? "Raisons d'annulation" : "Raison d'annulation"}
            </h2>
            {cancelReasonsDisplay.length > 0 ? (
              <ul className="space-y-1">
                {cancelReasonsDisplay.map((label) => (
                  <li className="text-sm text-text" key={label}>
                    {label}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-text">{order.cancel_reason?.trim() || '—'}</p>
            )}
          </section>
        ) : null}

        {mode === 'page' ? (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold uppercase text-muted">Actions</h2>
            {actionsMenu}
          </section>
        ) : null}
      </div>

      {mode === 'sheet' ? (
        <footer className="shrink-0 border-t border-border bg-surface p-5">{actionsMenu}</footer>
      ) : null}
    </div>
  );
}

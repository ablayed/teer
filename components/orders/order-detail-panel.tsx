'use client';

import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { DeliveryAddressForm } from '@/components/orders/delivery-address-form';
import { OrderActionsMenu } from '@/components/orders/order-actions-menu';
import type { DriverOption } from '@/components/orders/transition-dialog';
import { Button } from '@/components/ui/button';
import type { OrderDetail } from '@/lib/actions/orders';
import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import { cancelReasonLabels, isCancelReason } from '@/lib/domain/order-transition-actions';
import { formatMoney } from '@/lib/format/fcfa';
import { formatPhoneSN } from '@/lib/format/phone';
import type { Json } from '@/lib/supabase/database.types';
import { cn } from '@/lib/utils';
import {
  buildWhatsAppConfirmationUrl,
  buildWhatsAppDispatchUrl,
  firstName,
} from '@/lib/whatsapp/link';
import { ArrowLeft, MapPin, Pencil, ShoppingBag, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

type OrderDetailPanelProps = {
  drivers: DriverOption[];
  mode: 'page' | 'sheet';
  onClose?: () => void;
  order: OrderDetail;
  shopName: string;
  whatsappLabels: {
    confirm: string;
    missingPhone: string;
  };
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

export function OrderDetailPanel({
  drivers,
  mode,
  onClose,
  order,
  shopName,
  whatsappLabels,
}: OrderDetailPanelProps) {
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const emptyValue = 'Non renseigne';
  const currentStatus = toOrderStatus(order.cod_status);
  const shippingAddress = parseShippingAddress(order.shipping_address);
  const structuredAddress = order.delivery_address ?? order.customer_delivery_address;
  const items = parseItemsSummary(order.items_summary);
  const phone = order.customer?.phone ?? null;
  const fallbackQuartier = [shippingAddress?.address1, shippingAddress?.address2]
    .filter(Boolean)
    .join(', ');
  const formattedDeliveryAddress = formatAddress(shippingAddress, emptyValue);
  const addressForWhatsApp =
    formattedDeliveryAddress === emptyValue ? null : formattedDeliveryAddress;
  const whatsappUrl = buildWhatsAppConfirmationUrl({
    address: addressForWhatsApp,
    currency: order.currency,
    customerFirstName: firstName(order.customer?.full_name),
    itemsSummary: order.items_summary,
    orderNumber: order.order_number,
    phone,
    shopName,
    totalAmount: order.total_amount,
  });
  const dispatchWhatsAppUrl = buildWhatsAppDispatchUrl({
    address: addressForWhatsApp,
    currency: order.currency,
    customerFirstName: order.customer?.full_name ?? null,
    itemsSummary: order.items_summary,
    orderNumber: order.order_number,
    phone,
    shopName,
    totalAmount: order.total_amount,
  });
  const isCancelled = order.order_state === 'cancelled';
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
      deliveryState={order.delivery_state}
      dispatchWhatsAppUrl={dispatchWhatsAppUrl}
      drivers={drivers}
      orderId={order.id}
      phone={phone}
      whatsappLabels={whatsappLabels}
      whatsappUrl={whatsappUrl}
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

        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted">Total</p>
            <p className="mt-1 text-xl font-semibold">
              {formatMoney(order.total_amount, order.currency)}
            </p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-sm text-muted">Statut COD</p>
            <div className="mt-2">
              <CodStatusBadge status={currentStatus} />
            </div>
          </div>
        </section>

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

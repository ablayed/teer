'use client';

import { CodStatusBadge, codDisplayLabel } from '@/components/orders/cod-status-badge';
import { DeliveryAddressForm } from '@/components/orders/delivery-address-form';
import { OrderActionsMenu } from '@/components/orders/order-actions-menu';
import { OrderAmountsEditor } from '@/components/orders/order-amounts-editor';
import { OrderCartEditor } from '@/components/orders/order-cart-editor';
import { OrderDriverReassign } from '@/components/orders/order-driver-reassign';
import { OrderNoteEditor } from '@/components/orders/order-note-editor';
import type { DriverOption } from '@/components/orders/transition-dialog';
import { Button } from '@/components/ui/button';
import { WhatsappComposeSheet } from '@/components/whatsapp/whatsapp-compose-sheet';
import type { OrderDetail } from '@/lib/actions/orders';
import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import { cancelReasonLabels, isCancelReason } from '@/lib/domain/order-transition-actions';
import { formatDateTime } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import { formatPhoneSN } from '@/lib/format/phone';
import { getOrderCartEditingMode } from '@/lib/orders/cart-editing';
import { hasVisibleScheduledDelivery } from '@/lib/orders/scheduled-delivery';
import { filterShopifyAttributesForDisplay } from '@/lib/orders/shopify-attribute-display';
import type { Json } from '@/lib/supabase/database.types';
import { cn } from '@/lib/utils';
import { type WhatsappOrderData, parseItemsSummaryForWhatsapp } from '@/lib/whatsapp/format';
import {
  ArrowLeft,
  CalendarClock,
  Clock,
  MapPin,
  Pencil,
  Phone,
  ShoppingBag,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
  const pathname = usePathname();
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const emptyValue = 'Non renseigne';
  const currentStatus = toOrderStatus(order.cod_status);
  const shippingAddress = parseShippingAddress(order.shipping_address);
  const structuredAddress = order.delivery_address ?? order.customer_delivery_address;
  const items = parseItemsSummary(order.items_summary);
  const parsedOrderAttributes = parseOrderAttributes(order.shopify_order_attributes);
  const orderAttributes = parsedOrderAttributes
    ? {
        ...parsedOrderAttributes,
        attributes: filterShopifyAttributesForDisplay(parsedOrderAttributes.attributes),
      }
    : null;
  const lineItemAttributes = parseLineItemAttributes(order.shopify_line_item_attributes)
    .map((line) => ({
      ...line,
      attributes: filterShopifyAttributesForDisplay(line.attributes),
    }))
    .filter((line) => line.attributes.length > 0);
  const hasAdditionalDetails = orderAttributes !== null || lineItemAttributes.length > 0;
  const phone = order.customer?.phone ?? null;
  const fallbackQuartier = [shippingAddress?.address1, shippingAddress?.address2]
    .filter(Boolean)
    .join(', ');
  const formattedDeliveryAddress = formatAddress(shippingAddress, emptyValue);
  const whatsappOrderData: WhatsappOrderData = {
    orderId: order.id,
    numeroCommande: order.order_number,
    telephone: phone,
    adresse: formattedDeliveryAddress === emptyValue ? null : formattedDeliveryAddress,
    total: order.total_amount,
    items: parseItemsSummaryForWhatsapp(order.items_summary),
  };
  const isCancelled = order.order_state === 'cancelled';
  // UX-COD-01 §3 — appeler/WhatsApp sont promus juste sous l'en-tête (rail d'actions
  // rapides) ; même règle de template que l'ancien rendu dans OrderActionsMenu, seule
  // commande "ouverte" a un template client à proposer.
  const whatsappTemplate = order.order_state === 'open' ? ('clientConfirmation' as const) : null;
  // Sujet 1.1 : la date/heure programmée n'était visible que dans le modal
  // « Modifier les montants » (owner/manager). Affichée ici en lecture seule pour
  // tous les rôles, jour ET heure (fuseau Africa/Dakar via formatDateTime).
  const showScheduledDelivery = hasVisibleScheduledDelivery({
    deliveryState: order.delivery_state,
    scheduledFor: order.scheduled_for,
  });
  const cartEditingMode = getOrderCartEditingMode({
    cashState: order.cash_state,
    deliveryState: order.delivery_state,
  });
  const canEditCart = canEditAmounts && cartEditingMode !== null;
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
      scheduledFor={order.scheduled_for}
      whatsappOrderData={whatsappOrderData}
    />
  );

  return (
    <div className={contentClassName}>
      {/* UX-COD-01 §3 — en-tête stable : client, téléphone, montant, statut, date prévue,
          tous visibles sans interaction (avant : seuls order_number/nom/statut y étaient,
          téléphone/montant/date prévue n'apparaissaient que plus bas dans le corps). */}
      <header
        className={cn(
          'flex shrink-0 flex-col gap-3 border-b border-border bg-surface p-5',
          mode === 'page' && 'rounded-t-lg border shadow-1',
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="font-mono text-sm font-semibold text-muted">
              {order.order_number ?? emptyValue}
            </p>
            <h1 className="truncate text-xl font-semibold">
              {order.customer?.full_name ?? emptyValue}
            </h1>
            <p className="text-sm text-muted">{phone ? formatPhoneSN(phone) : emptyValue}</p>
          </div>
          {mode === 'sheet' ? (
            <button
              aria-label="Fermer"
              className="inline-flex size-12 shrink-0 items-center justify-center rounded-lg hover:bg-canvas"
              onClick={onClose}
              type="button"
            >
              <X aria-hidden="true" className="size-5" />
            </button>
          ) : onClose ? (
            // UX-COD-01 §4 — mode="page" rendu par OrderSideSheet sous `md` (navigation
            // douce depuis la liste, pas une entrée directe/hard-nav) : `onClose` est
            // fourni et vaut `router.back()`, pas un Link vers un pathname tronqué. Un
            // <Link href={pathname sans le dernier segment}> perdrait la recherche/vue
            // actives (ex. ?q=...&vue=confirmee) — seul l'historique les restaure.
            <button
              className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-lg px-3 font-medium text-muted hover:bg-canvas hover:text-text"
              onClick={onClose}
              type="button"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Retour
            </button>
          ) : (
            // Entrée directe (route /commandes/[id] hors interception — lien partagé,
            // favori, rechargement) : pas d'historique de navigation applicative fiable,
            // Link générique vers la liste.
            <Link
              className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-lg px-3 font-medium text-muted hover:bg-canvas hover:text-text"
              href={pathname.replace(/\/[^/]+$/, '') || '/commandes'}
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Retour
            </Link>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-mono font-semibold tabular-nums text-text">
            {formatMoney(order.total_amount, order.currency)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-medium text-muted">
            {codDisplayLabel(currentStatus, order.delivery_state)}
          </span>
          {showScheduledDelivery && order.scheduled_for ? (
            <>
              <span aria-hidden="true">·</span>
              <span
                className="flex items-center gap-1 text-accent"
                data-testid="order-header-scheduled-for"
              >
                <CalendarClock aria-hidden="true" className="size-4 shrink-0" />
                {formatDateTime(order.scheduled_for)}
              </span>
            </>
          ) : null}
        </div>
      </header>

      {/* UX-COD-01 §3 — rail d'actions rapides juste sous l'en-tête : appeler + WhatsApp,
          promus depuis OrderActionsMenu (qui ne rend plus, en mode non-compact, que
          « l'action du stade actuel »). Le troisième item listé par la spec (« adresse »)
          est retiré : aucune intégration cartographique n'existe dans ce dépôt, et un
          bouton qui se contente de faire défiler la page n'est pas une action rapide. */}
      {phone ? (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border p-5"
          data-testid="order-quick-actions"
        >
          <a
            className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-text hover:bg-canvas"
            href={`tel:${phone.replace(/\s/g, '')}`}
          >
            <Phone aria-hidden="true" className="size-4" />
            Appeler
          </a>
          <WhatsappComposeSheet
            order={whatsappOrderData}
            template={whatsappTemplate}
            trigger={
              <button
                className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-text hover:bg-canvas"
                type="button"
              >
                Message client
              </button>
            }
          />
        </div>
      ) : null}

      {/* UX-COD-01 §3 — « action du stade actuel » : juste sous le rail d'actions rapides,
          avant le reste du contenu (produits, livraison, historique, infos client).
          `OrderActionsMenu` rend `null` sans transition légale (commande terminale) : pas
          de conteneur/bordure ici pour éviter une bande vide dans ce cas. */}
      <div className="shrink-0 px-5 pt-5 empty:hidden">{actionsMenu}</div>

      <div
        className={cn(
          'space-y-5 p-5',
          mode === 'sheet' && 'min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8',
        )}
      >
        {/* UX-COD-01 §3 — ordre du corps désormais : produits → livraison et livreur →
            historique (aucune section existante à ce jour — no-op) → informations client.
            Client/téléphone/montant/statut/date prévue vivent déjà dans l'en-tête ; les
            sections ci-dessous restent pour le détail complet, pas dupliquées en tête. */}

        {/* Produits */}
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

        {canEditCart && cartEditingMode ? (
          <OrderCartEditor currency={order.currency} mode={cartEditingMode} orderId={order.id} />
        ) : null}

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

        {/* Livraison et livreur */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase text-muted">Adresse de livraison</h2>
            <Button
              className="min-h-12"
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

        {showScheduledDelivery && order.scheduled_for ? (
          <section
            className="rounded-lg border border-border p-4"
            data-testid="order-scheduled-for"
          >
            <p className="text-sm text-muted">Livraison programmée</p>
            <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-text">
              <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-accent" />
              {formatDateTime(order.scheduled_for)}
            </p>
          </section>
        ) : null}

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

        {/* Historique : aucune section n'existe à ce jour dans ce panneau (getOrderTimeline/
            CallLogForm sont du code mort, cf. CLAUDE.md) — no-op pour ce lot, pas de nouvelle
            requête inventée. */}

        {/* Informations client */}
        <section className="space-y-1" data-testid="order-created-at">
          <h2 className="text-sm font-semibold uppercase text-muted">Commande reçue</h2>
          <p className="flex items-center gap-2 text-sm text-text">
            <Clock aria-hidden="true" className="size-4 shrink-0 text-accent" />
            {formatDateTime(order.created_at_shopify ?? order.created_at)}
          </p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase text-muted">Client</h2>
          <p className="text-lg font-semibold">{order.customer?.full_name ?? emptyValue}</p>
          <p className="text-sm text-muted">{phone ? formatPhoneSN(phone) : emptyValue}</p>
        </section>

        {/* Note libre d'équipe (0118) — toujours montée, quel que soit l'état de
            la commande et quel que soit le rôle. À ne pas confondre avec la
            « Note : » du bloc « Détails supplémentaires » plus haut, qui est la
            note écrite par le CLIENT sur Shopify et reste en lecture seule. */}
        <OrderNoteEditor initialNote={order.note} orderId={order.id} />
      </div>
    </div>
  );
}

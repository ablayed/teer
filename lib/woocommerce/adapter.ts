// R2.4 / commit 6 — adaptateur WooCommerce pur.
//
// Ce module ne connaît ni Supabase, ni les actions serveur, ni l'environnement. Il transforme une
// commande REST WooCommerce en enveloppe canonique ; la résolution du tenant et toute écriture
// restent dans la couche applicative.
import type { CanonicalOrderAddress, PersistableCanonicalOrder } from '@/lib/ingestion/canonical';

export const WOO_COMMERCE_ORDER_STATUSES = [
  'draft',
  'pending',
  'processing',
  'on-hold',
  'completed',
  'failed',
  'cancelled',
  'refunded',
] as const;

export type WooCommerceOrderStatus = (typeof WOO_COMMERCE_ORDER_STATUSES)[number];

export type WooCommerceOrderChannelStatus = {
  readonly financialStatus: string;
  readonly fulfillmentStatus: string;
};

const STATUS_MAPPING: Record<WooCommerceOrderStatus, WooCommerceOrderChannelStatus> = {
  draft: { financialStatus: 'draft', fulfillmentStatus: 'unfulfilled' },
  pending: { financialStatus: 'pending', fulfillmentStatus: 'unfulfilled' },
  processing: { financialStatus: 'processing', fulfillmentStatus: 'processing' },
  'on-hold': { financialStatus: 'on-hold', fulfillmentStatus: 'on-hold' },
  completed: { financialStatus: 'completed', fulfillmentStatus: 'completed' },
  failed: { financialStatus: 'failed', fulfillmentStatus: 'failed' },
  cancelled: { financialStatus: 'cancelled', fulfillmentStatus: 'cancelled' },
  refunded: { financialStatus: 'refunded', fulfillmentStatus: 'refunded' },
};

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function dateString(value: unknown): string | null {
  const candidate = nonEmptyString(value);
  if (!candidate) return null;
  const hasTimezone = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(candidate);
  const timestamp = Date.parse(hasTimezone ? candidate : `${candidate}Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function decimal(value: unknown): number | null {
  const candidate = nonEmptyString(value);
  if (!candidate || !/^\d+(?:\.\d+)?$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

function externalNumericId(value: unknown, allowZero = false): string | null {
  const candidate =
    typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string' && /^\d+$/.test(value)
        ? value
        : null;
  if (!candidate) return null;
  const normalized = candidate.replace(/^0+(?=\d)/, '');
  if (!allowZero && normalized === '0') return null;
  return normalized;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() || null : null;
}

function mapAddress(value: unknown): CanonicalOrderAddress | null {
  const input = record(value);
  if (!input) return null;
  const address: CanonicalOrderAddress = {
    address1: optionalString(input.address_1),
    address2: optionalString(input.address_2),
    city: optionalString(input.city),
    province: optionalString(input.state),
    country: optionalString(input.country),
    zip: optionalString(input.postcode),
  };
  return Object.values(address).some((part) => part !== null) ? address : null;
}

function joinName(first: unknown, last: unknown): string | null {
  const name = [optionalString(first), optionalString(last)].filter(
    (part): part is string => part !== null,
  );
  return name.length > 0 ? name.join(' ') : null;
}

function mapLine(value: unknown) {
  const input = record(value);
  if (!input) return null;
  const title = nonEmptyString(input.name);
  const quantity =
    typeof input.quantity === 'number' && Number.isSafeInteger(input.quantity)
      ? input.quantity
      : null;
  if (!title || quantity === null || quantity <= 0) return null;

  const total = decimal(input.total);
  return {
    title,
    sku: optionalString(input.sku),
    quantity,
    unitAmount: total === null ? decimal(input.price) : total / quantity,
    productId: null,
  };
}

export function mapWooCommerceOrder(value: unknown): PersistableCanonicalOrder | null {
  const input = record(value);
  if (!input) return null;

  const externalOrderId = externalNumericId(input.id);
  const createdAt = dateString(input.date_created_gmt);
  const updatedAt = dateString(input.date_modified_gmt);
  const status = nonEmptyString(input.status);
  const totalAmount = decimal(input.total);
  const lines = Array.isArray(input.line_items) ? input.line_items.map(mapLine) : [];
  const billing = record(input.billing);
  const shipping = record(input.shipping);
  const mappedStatus =
    status && WOO_COMMERCE_ORDER_STATUSES.includes(status as WooCommerceOrderStatus)
      ? STATUS_MAPPING[status as WooCommerceOrderStatus]
      : null;

  if (
    !externalOrderId ||
    !createdAt ||
    !updatedAt ||
    !status ||
    !mappedStatus ||
    totalAmount === null ||
    lines.length === 0 ||
    lines.some((line) => line === null)
  ) {
    return null;
  }

  const customerId = externalNumericId(input.customer_id, true);
  const billingAddress = mapAddress(input.billing);
  const shippingAddress = mapAddress(input.shipping);

  return {
    kind: 'order',
    externalOrderId,
    raw: value,
    data: {
      payloadVersion: 'woocommerce-rest-v3',
      eventAt: updatedAt,
      createdAt,
      updatedAt,
      orderNumber: nonEmptyString(input.number) ?? externalOrderId,
      totalAmount,
      currency: nonEmptyString(input.currency)?.toUpperCase() ?? 'XOF',
      financialStatus: mappedStatus.financialStatus,
      fulfillmentStatus: mappedStatus.fulfillmentStatus,
      customer: {
        externalId: customerId === '0' ? null : customerId,
        fullName: joinName(billing?.first_name, billing?.last_name),
        phone: optionalString(billing?.phone) ?? optionalString(shipping?.phone),
        address: billingAddress,
      },
      shippingAddress,
      lines: lines as Array<NonNullable<(typeof lines)[number]>>,
    },
  };
}

export function mapWooCommerceStatus(status: string): WooCommerceOrderChannelStatus | null {
  return WOO_COMMERCE_ORDER_STATUSES.includes(status as WooCommerceOrderStatus)
    ? STATUS_MAPPING[status as WooCommerceOrderStatus]
    : null;
}

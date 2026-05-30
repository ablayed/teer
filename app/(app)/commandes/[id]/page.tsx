import { CodStatusBadge } from '@/components/orders/cod-status-badge';
import { CodStatusSelector } from '@/components/orders/cod-status-selector';
import { getOrderById } from '@/lib/actions/orders';
import { formatDateAbsolute } from '@/lib/format/date';
import { formatFCFA } from '@/lib/format/fcfa';
import { formatPhoneSN, toWhatsAppLink } from '@/lib/format/phone';
import { isCodStatus } from '@/lib/orders/status';
import type { Json } from '@/lib/supabase/database.types';
import { ArrowLeft, Mail, MapPin, Phone, ShoppingBag } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';

type OrderDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
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

export default async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const t = await getTranslations('orders');
  const { id } = await params;
  const order = await getOrderById(id);

  if (!order) {
    notFound();
  }

  const status = isCodStatus(order.cod_status) ? order.cod_status : 'nouvelle';
  const emptyValue = t('table.emptyValue');
  const shippingAddress = parseShippingAddress(order.shipping_address);
  const items = parseItemsSummary(order.items_summary);
  const phone = order.customer?.phone;

  return (
    <main className="space-y-6" id="main">
      <Link
        className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 font-medium text-muted hover:bg-surface hover:text-text"
        href="/commandes"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t('detail.back')}
      </Link>

      <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-4xl md:text-5xl">
                {order.order_number ?? emptyValue}
              </h1>
              <CodStatusBadge status={status} />
            </div>
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted">{t('detail.total')}</dt>
                <dd className="mt-1 text-2xl font-semibold">{formatFCFA(order.total_amount)}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('detail.createdAt')}</dt>
                <dd className="mt-1 font-medium">
                  {order.created_at_shopify
                    ? formatDateAbsolute(order.created_at_shopify)
                    : emptyValue}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <section className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-1">
          <h2 className="text-xl font-semibold">{t('detail.customer')}</h2>
          <div className="space-y-3 text-sm">
            <p className="text-lg font-semibold">{order.customer?.full_name ?? emptyValue}</p>
            <div className="flex flex-wrap gap-2">
              {phone ? (
                <>
                  <a
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 font-medium hover:bg-canvas"
                    href={toWhatsAppLink(phone)}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <Phone aria-hidden="true" className="size-4" />
                    {t('detail.whatsapp')}
                  </a>
                  <a
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 font-medium hover:bg-canvas"
                    href={`tel:${phone.replace(/\s/g, '')}`}
                  >
                    <Phone aria-hidden="true" className="size-4" />
                    {t('detail.call')}
                  </a>
                </>
              ) : null}
            </div>
            <dl className="grid gap-3">
              <div>
                <dt className="text-muted">{t('detail.phone')}</dt>
                <dd className="mt-1 font-medium">{phone ? formatPhoneSN(phone) : emptyValue}</dd>
              </div>
              <div>
                <dt className="text-muted">{t('detail.email')}</dt>
                <dd className="mt-1 flex items-center gap-2 font-medium">
                  <Mail aria-hidden="true" className="size-4 text-muted" />
                  {order.customer?.email ?? emptyValue}
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-1">
          <h2 className="text-xl font-semibold">{t('detail.delivery')}</h2>
          <p className="flex gap-2 text-sm leading-6 text-muted">
            <MapPin aria-hidden="true" className="mt-1 size-4 shrink-0 text-accent" />
            {formatAddress(shippingAddress, emptyValue)}
          </p>
        </section>
      </div>

      <section className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-1">
        <h2 className="text-xl font-semibold">{t('detail.items')}</h2>
        {items.length > 0 ? (
          <div className="divide-y divide-border">
            {items.map((item, index) => (
              <div
                className="flex items-center justify-between gap-4 py-3"
                key={`${item.title}-${index}`}
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-canvas text-accent">
                    <ShoppingBag aria-hidden="true" className="size-5" />
                  </span>
                  <div>
                    <p className="font-medium">{item.title || emptyValue}</p>
                    <p className="text-sm text-muted">
                      {item.quantity} {t('detail.quantitySeparator')} {formatFCFA(item.price)}
                    </p>
                  </div>
                </div>
                <p className="font-semibold">{formatFCFA(item.quantity * item.price)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{t('detail.noItems')}</p>
        )}
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-1">
          <h2 className="text-xl font-semibold">{t('detail.shopifyStatus')}</h2>
          <dl className="grid gap-3 text-sm">
            <div>
              <dt className="text-muted">{t('detail.financialStatus')}</dt>
              <dd className="mt-1 font-medium">{order.financial_status ?? emptyValue}</dd>
            </div>
            <div>
              <dt className="text-muted">{t('detail.fulfillmentStatus')}</dt>
              <dd className="mt-1 font-medium">{order.fulfillment_status ?? emptyValue}</dd>
            </div>
          </dl>
        </div>

        <div className="space-y-4 rounded-lg border border-border bg-surface p-5 shadow-1">
          <h2 className="text-xl font-semibold">{t('detail.codActions')}</h2>
          <CodStatusSelector currentStatus={status} orderId={order.id} />
        </div>
      </section>
    </main>
  );
}

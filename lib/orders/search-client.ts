'use client';

import type { OrdersPageData } from '@/lib/actions/orders';
import type { OrderSavedViewId } from '@/lib/domain/order-saved-views';

type OrdersSearchRequest = {
  dateFrom: string;
  dateTo: string;
  search: string;
  shopId: string | null;
  view: OrderSavedViewId;
};

export class OrdersSearchHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Orders search request failed with status ${status}`);
    this.name = 'OrdersSearchHttpError';
    this.status = status;
  }
}

export async function fetchOrdersSearchPageData(
  input: OrdersSearchRequest,
  signal: AbortSignal,
): Promise<OrdersPageData> {
  const response = await fetch('/api/orders/search', {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-teer-audit-request-id': crypto.randomUUID(),
    },
    method: 'POST',
    body: JSON.stringify({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      q: input.search,
      shopId: input.shopId,
      view: input.view,
    }),
    signal,
  });

  if (!response.ok) {
    throw new OrdersSearchHttpError(response.status);
  }

  return (await response.json()) as OrdersPageData;
}

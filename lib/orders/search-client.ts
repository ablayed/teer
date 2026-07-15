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
  const params = new URLSearchParams({
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    q: input.search,
    view: input.view,
  });

  if (input.shopId) {
    params.set('shopId', input.shopId);
  }

  const response = await fetch(`/api/orders/search?${params.toString()}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    method: 'GET',
    signal,
  });

  if (!response.ok) {
    throw new OrdersSearchHttpError(response.status);
  }

  return (await response.json()) as OrdersPageData;
}

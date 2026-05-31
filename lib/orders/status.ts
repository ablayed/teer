import { type OrderStatus, orderStatuses } from '@/lib/domain/order-state-machine';

export const codStatuses = orderStatuses;

export type CodStatus = OrderStatus;

export function isCodStatus(value: string): value is CodStatus {
  return codStatuses.includes(value as CodStatus);
}

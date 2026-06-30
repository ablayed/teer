import {
  type CodDisplayStatus,
  codDisplayLabel,
  codStatusTokenClass,
  resolveCodDisplayStatus,
} from '@/components/orders/cod-status-badge';
import { StatusBadge } from '@/components/ui/status-badge';
import type { OrderStatus } from '@/lib/domain/order-state-machine';

type CodStatusListBadgeProps = {
  deliveryState?: string | null;
  status: OrderStatus;
};

export type { CodDisplayStatus };

export function CodStatusListBadge({ deliveryState, status }: CodStatusListBadgeProps) {
  const displayStatus = resolveCodDisplayStatus(status, deliveryState);
  return (
    <StatusBadge
      className={codStatusTokenClass(displayStatus)}
      label={codDisplayLabel(status, deliveryState)}
    />
  );
}

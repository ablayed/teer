'use client';

import { Badge } from '@/components/ui/badge';
import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import { cn } from '@/lib/utils';
import { Ban, CheckCircle2, Circle, Clock3, PackageCheck, PhoneCall, Truck } from 'lucide-react';

type CodStatusBadgeProps = {
  className?: string;
  status: OrderStatus;
};

const badgeStyles: Record<OrderStatus, string> = {
  A_APPELER: 'border-accent/35 bg-accent-subtle text-text',
  TENTEE: 'border-border bg-canvas text-muted',
  CONFIRMEE: 'border-border bg-surface text-text',
  PROGRAMMEE: 'border-border bg-surface text-text',
  EN_LIVRAISON: 'border-accent/35 bg-accent text-accent-ink',
  LIVREE: 'border-success/25 bg-success-subtle text-success',
  REFUSEE: 'border-danger/25 bg-danger-subtle text-danger',
  ANNULEE: 'border-danger/25 bg-danger-subtle text-danger',
};

const icons = {
  A_APPELER: PhoneCall,
  TENTEE: Clock3,
  CONFIRMEE: CheckCircle2,
  PROGRAMMEE: Circle,
  EN_LIVRAISON: Truck,
  LIVREE: PackageCheck,
  REFUSEE: Ban,
  ANNULEE: Ban,
} satisfies Record<OrderStatus, typeof Circle>;

export function CodStatusBadge({ className, status }: CodStatusBadgeProps) {
  const Icon = icons[status];

  return (
    <Badge
      aria-label={orderStatusLabels[status]}
      className={cn('rounded-full', badgeStyles[status], className)}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {orderStatusLabels[status]}
    </Badge>
  );
}

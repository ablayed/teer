'use client';

import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import { cn } from '@/lib/utils';
import { Ban, CheckCircle2, Circle, Clock3, PackageCheck, PhoneCall, Truck } from 'lucide-react';

type CodStatusBadgeProps = {
  className?: string;
  status: OrderStatus;
};

const badgeStyles: Record<OrderStatus, string> = {
  A_APPELER: 'border-border bg-canvas text-muted',
  TENTEE: 'border-amber-300 bg-amber-50 text-amber-900',
  CONFIRMEE: 'border-blue-200 bg-blue-50 text-blue-800',
  PROGRAMMEE: 'border-violet-200 bg-violet-50 text-violet-800',
  EN_LIVRAISON: 'border-accent/35 bg-accent text-[#111]',
  LIVREE: 'border-success/25 bg-green-50 text-success',
  REFUSEE: 'border-danger/25 bg-red-50 text-danger',
  ANNULEE: 'border-neutral-300 bg-neutral-100 text-neutral-800',
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
    <span
      aria-label={orderStatusLabels[status]}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold',
        badgeStyles[status],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {orderStatusLabels[status]}
    </span>
  );
}

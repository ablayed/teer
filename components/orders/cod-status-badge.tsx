'use client';

import { Badge } from '@/components/ui/badge';
import { type OrderStatus, orderStatusLabels } from '@/lib/domain/order-state-machine';
import { cn } from '@/lib/utils';
import {
  Ban,
  CheckCircle2,
  Circle,
  Clock3,
  PackageCheck,
  PhoneCall,
  Truck,
  UserCheck,
} from 'lucide-react';

// Phase 11.1 (option C) : « Assignée » (delivery_state=assigned) et « En cours de
// livraison » (delivery_state=out_for_delivery) partagent le cod_status legacy
// EN_LIVRAISON. Pour les distinguer à l'écran, on dérive un statut d'AFFICHAGE de
// la dimension delivery_state (source de vérité), sans toucher au legacy.
export type CodDisplayStatus = OrderStatus | 'ASSIGNEE';

export function resolveCodDisplayStatus(
  status: OrderStatus,
  deliveryState?: string | null,
): CodDisplayStatus {
  if (status === 'EN_LIVRAISON' && deliveryState === 'assigned') {
    return 'ASSIGNEE';
  }
  return status;
}

const displayLabels: Record<CodDisplayStatus, string> = {
  ...orderStatusLabels,
  EN_LIVRAISON: 'En cours de livraison',
  ASSIGNEE: 'Assignée',
};

export function codDisplayLabel(status: OrderStatus, deliveryState?: string | null): string {
  return displayLabels[resolveCodDisplayStatus(status, deliveryState)];
}

type CodStatusBadgeProps = {
  className?: string;
  deliveryState?: string | null;
  status: OrderStatus;
};

const badgeStyles: Record<CodDisplayStatus, string> = {
  A_APPELER: 'border-accent/35 bg-accent-subtle text-text',
  TENTEE: 'border-border bg-canvas text-muted',
  CONFIRMEE: 'border-border bg-surface text-text',
  PROGRAMMEE: 'border-border bg-surface text-text',
  ASSIGNEE: 'border-accent/35 bg-accent-subtle text-text',
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
  ASSIGNEE: UserCheck,
  EN_LIVRAISON: Truck,
  LIVREE: PackageCheck,
  REFUSEE: Ban,
  ANNULEE: Ban,
} satisfies Record<CodDisplayStatus, typeof Circle>;

const tokenClasses = {
  A_APPELER: 'bg-status-a-appeler/15 text-status-a-appeler',
  TENTEE: 'bg-status-tentee/15 text-status-tentee',
  CONFIRMEE: 'bg-status-confirmee/15 text-status-confirmee',
  PROGRAMMEE: 'bg-status-programmee/15 text-status-programmee',
  ASSIGNEE: 'bg-status-assignee/15 text-status-assignee',
  EN_LIVRAISON: 'bg-status-en-livraison/15 text-status-en-livraison',
  LIVREE: 'bg-status-livree/15 text-status-livree',
  REFUSEE: 'bg-status-refusee/15 text-status-refusee',
  ANNULEE: 'bg-status-annulee/15 text-status-annulee',
} satisfies Record<CodDisplayStatus, string>;

export function codStatusTokenClass(status: CodDisplayStatus): string {
  return tokenClasses[status];
}

export function CodStatusBadge({ className, deliveryState, status }: CodStatusBadgeProps) {
  const displayStatus = resolveCodDisplayStatus(status, deliveryState);
  const Icon = icons[displayStatus];
  const label = displayLabels[displayStatus];

  return (
    <Badge aria-label={label} className={cn('rounded-full', badgeStyles[displayStatus], className)}>
      <Icon aria-hidden="true" className="size-3.5" />
      {label}
    </Badge>
  );
}

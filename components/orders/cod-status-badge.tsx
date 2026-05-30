'use client';

import type { CodStatus } from '@/lib/orders/status';
import { cn } from '@/lib/utils';
import { Ban, CheckCircle2, Circle, PackageCheck, RotateCcw, Truck, UserCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

type CodStatusBadgeProps = {
  className?: string;
  status: CodStatus;
};

const badgeStyles: Record<CodStatus, string> = {
  nouvelle: 'border-border bg-canvas text-muted',
  confirmee: 'border-blue-200 bg-blue-50 text-blue-800',
  assignee: 'border-violet-200 bg-violet-50 text-violet-800',
  en_livraison: 'border-accent/35 bg-accent text-[#111]',
  livree: 'border-success/25 bg-green-50 text-success',
  annulee: 'border-danger/25 bg-red-50 text-danger',
  retournee: 'border-amber-300 bg-amber-50 text-amber-900',
};

const icons = {
  nouvelle: Circle,
  confirmee: CheckCircle2,
  assignee: UserCheck,
  en_livraison: Truck,
  livree: PackageCheck,
  annulee: Ban,
  retournee: RotateCcw,
} satisfies Record<CodStatus, typeof Circle>;

export function CodStatusBadge({ className, status }: CodStatusBadgeProps) {
  const t = useTranslations('orders.status');
  const Icon = icons[status];

  return (
    <span
      aria-label={t(status)}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold',
        badgeStyles[status],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {t(status)}
    </span>
  );
}

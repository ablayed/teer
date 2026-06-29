import { StatusBadge } from '@/components/ui/status-badge';
import type { OrderStatus } from '@/lib/domain/order-state-machine';

// Consomme les --status-* du socle 1/2 : premier usage réel dans ce ticket.
// ISOLEMENT : ce composant n'est importé que par la page de démo — il ne remplace
// pas components/orders/cod-status-badge.tsx (live, migré dans un ticket dédié).
const DEMO_STATUS_CLASS = {
  A_APPELER: 'bg-status-a-appeler/15 text-status-a-appeler',
  TENTEE: 'bg-status-tentee/15 text-status-tentee',
  CONFIRMEE: 'bg-status-confirmee/15 text-status-confirmee',
  PROGRAMMEE: 'bg-status-programmee/15 text-status-programmee',
  EN_LIVRAISON: 'bg-status-en-livraison/15 text-status-en-livraison',
  LIVREE: 'bg-status-livree/15 text-status-livree',
  REFUSEE: 'bg-status-refusee/15 text-status-refusee',
  ANNULEE: 'bg-status-annulee/15 text-status-annulee',
} satisfies Record<OrderStatus, string>;

export function DemoCodStatusBadge({
  status,
  label,
}: {
  status: OrderStatus;
  label: string;
}) {
  return <StatusBadge className={DEMO_STATUS_CLASS[status]} label={label} />;
}

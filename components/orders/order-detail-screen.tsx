import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import { OrderSideSheet } from '@/components/orders/order-side-sheet';
import { getActiveDrivers } from '@/lib/actions/drivers';
import { getMerchantMemberForUser } from '@/lib/actions/merchant';
import { getOrderById } from '@/lib/actions/orders';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { notFound } from 'next/navigation';

type OrderDetailScreenProps = {
  mode: 'page' | 'sheet';
  orderId: string;
};

export async function OrderDetailScreen({ mode, orderId }: OrderDetailScreenProps) {
  const [order, drivers, role] = await Promise.all([
    getOrderById(orderId),
    getActiveDrivers(),
    getCurrentRole(),
  ]);
  // Phase 11 : seuls owner/manager éditent les montants (total + frais de livraison).
  const canEditAmounts = role === 'owner' || role === 'manager';

  if (!order) {
    notFound();
  }

  if (mode === 'sheet') {
    return <OrderSideSheet canEditAmounts={canEditAmounts} drivers={drivers} order={order} />;
  }

  return (
    <main id="main">
      <OrderDetailPanel
        canEditAmounts={canEditAmounts}
        drivers={drivers}
        mode="page"
        order={order}
      />
    </main>
  );
}

// Rôle du membre courant (pour décider qui peut éditer les montants). Lecture
// scopée à l'utilisateur authentifié (admin client côté getMerchantMemberForUser).
async function getCurrentRole(): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return null;
  }
  const member = await getMerchantMemberForUser(user.id);
  return member?.role ?? null;
}

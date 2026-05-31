import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import { OrderSideSheet } from '@/components/orders/order-side-sheet';
import { getOrderById, getOrderTimeline } from '@/lib/actions/orders';
import { notFound } from 'next/navigation';

type OrderDetailScreenProps = {
  mode: 'page' | 'sheet';
  orderId: string;
};

export async function OrderDetailScreen({ mode, orderId }: OrderDetailScreenProps) {
  const [order, timeline] = await Promise.all([getOrderById(orderId), getOrderTimeline(orderId)]);

  if (!order) {
    notFound();
  }

  if (mode === 'sheet') {
    return <OrderSideSheet order={order} timeline={timeline} />;
  }

  return (
    <main id="main">
      <OrderDetailPanel mode="page" order={order} timeline={timeline} />
    </main>
  );
}

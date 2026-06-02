import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import { OrderSideSheet } from '@/components/orders/order-side-sheet';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { getOrderById, getOrderTimeline } from '@/lib/actions/orders';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

type OrderDetailScreenProps = {
  mode: 'page' | 'sheet';
  orderId: string;
};

export async function OrderDetailScreen({ mode, orderId }: OrderDetailScreenProps) {
  const [order, timeline, merchant] = await Promise.all([
    getOrderById(orderId),
    getOrderTimeline(orderId),
    getMerchantAccount(),
  ]);
  const t = await getTranslations('orders');
  const whatsappLabels = {
    confirm: t('whatsapp.confirm'),
    missingPhone: t('whatsapp.missingPhone'),
  };

  if (!order) {
    notFound();
  }

  if (mode === 'sheet') {
    return (
      <OrderSideSheet
        order={order}
        shopName={merchant?.name ?? 'Tëër'}
        timeline={timeline}
        whatsappLabels={whatsappLabels}
      />
    );
  }

  return (
    <main id="main">
      <OrderDetailPanel
        mode="page"
        order={order}
        shopName={merchant?.name ?? 'Tëër'}
        timeline={timeline}
        whatsappLabels={whatsappLabels}
      />
    </main>
  );
}

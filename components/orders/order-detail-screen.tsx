import { OrderDetailPanel } from '@/components/orders/order-detail-panel';
import { OrderSideSheet } from '@/components/orders/order-side-sheet';
import { getActiveDrivers } from '@/lib/actions/drivers';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { getOrderById } from '@/lib/actions/orders';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

type OrderDetailScreenProps = {
  mode: 'page' | 'sheet';
  orderId: string;
};

export async function OrderDetailScreen({ mode, orderId }: OrderDetailScreenProps) {
  const [order, merchant, drivers] = await Promise.all([
    getOrderById(orderId),
    getMerchantAccount(),
    getActiveDrivers(),
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
        drivers={drivers}
        order={order}
        shopName={merchant?.name ?? 'Tëër'}
        whatsappLabels={whatsappLabels}
      />
    );
  }

  return (
    <main id="main">
      <OrderDetailPanel
        drivers={drivers}
        mode="page"
        order={order}
        shopName={merchant?.name ?? 'Tëër'}
        whatsappLabels={whatsappLabels}
      />
    </main>
  );
}

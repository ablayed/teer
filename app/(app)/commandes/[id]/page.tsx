import { OrderDetailScreen } from '@/components/orders/order-detail-screen';
import { withMessages } from '@/lib/i18n/messages-for';

type OrderDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const { id } = await params;

  return <OrderDetailScreen mode="page" orderId={id} />;
}

export default withMessages(['orders', 'whatsapp'], OrderDetailPage);

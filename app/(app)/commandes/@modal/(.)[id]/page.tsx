import { OrderDetailScreen } from '@/components/orders/order-detail-screen';
import { withMessages } from '@/lib/i18n/messages-for';

type InterceptedOrderDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

async function InterceptedOrderDetailPage({ params }: InterceptedOrderDetailPageProps) {
  const { id } = await params;

  return <OrderDetailScreen mode="sheet" orderId={id} />;
}

export default withMessages(['orders', 'whatsapp'], InterceptedOrderDetailPage);

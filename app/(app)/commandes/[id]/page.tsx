import { OrderDetailScreen } from '@/components/orders/order-detail-screen';

type OrderDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function OrderDetailPage({ params }: OrderDetailPageProps) {
  const { id } = await params;

  return <OrderDetailScreen mode="page" orderId={id} />;
}

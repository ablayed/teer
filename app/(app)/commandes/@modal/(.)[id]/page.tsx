import { OrderDetailScreen } from '@/components/orders/order-detail-screen';

type InterceptedOrderDetailPageProps = {
  params: Promise<{
    id: string;
  }>;
};

export default async function InterceptedOrderDetailPage({
  params,
}: InterceptedOrderDetailPageProps) {
  const { id } = await params;

  return <OrderDetailScreen mode="sheet" orderId={id} />;
}

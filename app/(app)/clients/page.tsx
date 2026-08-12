import { ClientsWorkspace } from '@/components/clients/clients-workspace';
import { getRequestStoreId } from '@/lib/workspace/store';
import { redirect } from 'next/navigation';

export default async function ClientsPage() {
  const storeId = await getRequestStoreId();
  if (!storeId) redirect('/s');
  return <ClientsWorkspace storeId={storeId} />;
}

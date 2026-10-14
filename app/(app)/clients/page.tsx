import { ClientsWorkspace } from '@/components/clients/clients-workspace';
import { withMessages } from '@/lib/i18n/messages-for';
import { getRequestStoreId } from '@/lib/workspace/store';
import { redirect } from 'next/navigation';

async function ClientsPage() {
  const storeId = await getRequestStoreId();
  if (!storeId) redirect('/s');
  return <ClientsWorkspace storeId={storeId} />;
}

export default withMessages(['clients'], ClientsPage);

import { StoreChooser } from '@/components/workspace/store-chooser';
import { defaultWorkspaceStore, getWorkspaceStores } from '@/lib/workspace/store';
import { redirect } from 'next/navigation';

export default async function WorkspaceEntryPage() {
  const stores = await getWorkspaceStores();
  const defaultStore = defaultWorkspaceStore(stores);

  if (!defaultStore) {
    redirect('/onboarding');
  }

  if (stores.length === 1) {
    redirect(`/s/${defaultStore.id}/tableau`);
  }

  return <StoreChooser stores={stores} />;
}

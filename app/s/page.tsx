import { StoreChooser } from '@/components/workspace/store-chooser';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { defaultWorkspaceStore, getWorkspaceStores } from '@/lib/workspace/store';
import { redirect } from 'next/navigation';

export default async function WorkspaceEntryPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/connexion?redirectTo=%2Fs');
  }

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

import { verifyEmbeddedLinkIntent } from '@/lib/shopify/embedded-link-intent';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { EmbeddedLinkConfirmForm } from './embedded-link-confirm-form';

export const dynamic = 'force-dynamic';

type EmbeddedLinkPageProps = {
  searchParams: Promise<{ intent?: string }>;
};

type MerchantAccountOption = { id: string; name: string };

// Écran de confirmation du rattachement Teer Public — rendu pur (GET), aucune écriture. Nomme la
// boutique cible et laisse l'utilisateur choisir explicitement le tenant si nécessaire ; l'écriture
// part exclusivement du POST protégé (linkShopifyEmbeddedShopAction).
async function listUserMerchantAccounts(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  userId: string,
): Promise<MerchantAccountOption[]> {
  const membershipsResult = await supabase
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', userId);
  const memberships = (membershipsResult.data ?? []) as Array<{ merchant_account_id: string }>;

  const accountIds = [...new Set(memberships.map((m) => m.merchant_account_id))];
  if (accountIds.length === 0) {
    return [];
  }

  const accountsResult = await supabase
    .from('merchant_account')
    .select('id, name')
    .in('id', accountIds)
    .is('deleted_at', null);
  const accounts = (accountsResult.data ?? []) as MerchantAccountOption[];

  return accounts.map((account) => ({ id: account.id, name: account.name }));
}

export default async function EmbeddedLinkPage({ searchParams }: EmbeddedLinkPageProps) {
  const { intent: rawIntent } = await searchParams;
  const intent = rawIntent ? verifyEmbeddedLinkIntent(rawIntent) : null;

  if (!rawIntent || !intent) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="font-display text-2xl">Lien de rattachement invalide</h1>
        <p className="mt-3 text-sm text-muted">
          Ce lien a expiré ou n’est plus valide. Retournez dans Shopify Admin et réessayez.
        </p>
      </main>
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      `/connexion?redirectTo=${encodeURIComponent(`/shopify/embedded-link?intent=${rawIntent}`)}`,
    );
  }

  const accounts = await listUserMerchantAccounts(supabase, user.id);

  if (accounts.length === 0) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="font-display text-2xl">Aucun compte marchand disponible</h1>
        <p className="mt-3 text-sm text-muted">
          Votre compte Tëër n’est rattaché à aucune boutique. Contactez le support avant de
          poursuivre.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="font-display text-2xl">Associer cette boutique à Tëër</h1>
      <p className="mt-3 text-sm text-muted">
        Shopify demande à rattacher <span className="font-semibold">{intent.shopDomain}</span> à
        votre compte Tëër. Cette action est irréversible sans passer par le support.
      </p>
      <EmbeddedLinkConfirmForm intent={rawIntent} accounts={accounts} />
    </main>
  );
}

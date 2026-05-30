import { ConnectShopBanner } from '@/components/shops/connect-shop-banner';
import { getMerchantAccount } from '@/lib/actions/merchant';
import { getShopConnection } from '@/lib/actions/shopify';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getTranslations } from 'next-intl/server';

export default async function TableauPage() {
  const t = await getTranslations('app');
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const merchantAccount = await getMerchantAccount();
  const shopConnection = await getShopConnection();
  const name = merchantAccount?.name ?? user?.email?.split('@')[0] ?? '';

  return (
    <main className="space-y-4" id="main">
      <ConnectShopBanner hasShop={Boolean(shopConnection)} />
      <h1 className="font-display text-4xl md:text-5xl">{t('greeting', { name })}</h1>
      <p className="text-muted">{t('tableauPlaceholder')}</p>
    </main>
  );
}

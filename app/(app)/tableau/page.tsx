import { createSupabaseServerClient } from '@/lib/supabase/server';
import { getTranslations } from 'next-intl/server';

export default async function TableauPage() {
  const t = await getTranslations('app');
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const name = user?.email?.split('@')[0] ?? '';

  return (
    <section className="space-y-4">
      <h1 className="font-display text-4xl md:text-5xl">{t('greeting', { name })}</h1>
      <p className="text-muted">{t('tableauPlaceholder')}</p>
    </section>
  );
}

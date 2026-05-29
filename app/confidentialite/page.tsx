import { getTranslations } from 'next-intl/server';

export default async function PrivacyPage() {
  const t = await getTranslations('common');

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-5 text-text">
      <h1 className="font-display text-4xl">{t('underConstruction')}</h1>
    </main>
  );
}

import { getTranslations } from 'next-intl/server';

export default async function ProduitsPage() {
  const nav = await getTranslations('nav');
  const placeholders = await getTranslations('placeholders');

  return (
    <main className="space-y-3" id="main">
      <h1 className="font-display text-4xl md:text-5xl">{nav('produits')}</h1>
      <p className="text-muted">{placeholders('generic')}</p>
    </main>
  );
}

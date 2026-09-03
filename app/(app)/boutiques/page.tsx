import { redirect } from 'next/navigation';

type BoutiquesPageProps = {
  searchParams: Promise<{
    connected?: string;
    error?: string;
  }>;
};

// Ancienne surface de gestion Shopify, remplacée par Paramètres > Boutiques
// (SHOP-01) : cette page ne fait plus que rediriger, en reportant uniquement
// `connected`/`error` — les seuls paramètres que le flux OAuth (callback/
// install route.ts) émet vers cette route. `redirect()` perd les query params
// par défaut ; on construit donc l'URL de destination explicitement.
export default async function BoutiquesPage({ searchParams }: BoutiquesPageProps) {
  const params = await searchParams;
  const target = new URLSearchParams();
  target.set('tab', 'shops');

  if (params.connected) {
    target.set('connected', params.connected);
  }

  if (params.error) {
    target.set('error', params.error);
  }

  redirect(`/parametres?${target.toString()}`);
}

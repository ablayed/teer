import { request } from '@playwright/test';

const WARM_UP_ROUTES = [
  '/',
  '/connexion',
  '/tableau',
  '/livraison',
  '/commandes',
  '/produits',
  '/clients',
  '/finances',
  '/analyses',
  '/assistant',
];

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function globalSetup() {
  const baseURL = process.env.E2E_URL ?? 'http://localhost:3000';
  const context = await request.newContext({ baseURL });

  for (const route of WARM_UP_ROUTES) {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // On veut déclencher la compilation on-demand — le code HTTP importe peu.
        await context.get(route, { timeout: 30_000 });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await sleep(2_000);
      }
    }
    if (lastErr) {
      // Non-fatal : un warm-up raté vaut mieux qu'un warm-up absent.
      console.warn(`[warm-up] ${route} échoué après 3 tentatives :`, lastErr);
    }
  }

  await context.dispose();
}

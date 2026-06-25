import { request } from '@playwright/test';

// Toutes les routes LOURDES sont pré-compilées ici, AVANT que les specs démarrent,
// pour qu'aucun test n'atterrisse sur une compilation on-demand `next dev` à froid
// (cf. dette E2E : /tableau = 5440 modules, ~8-20s à compiler sous charge → timeouts
// qui font flaky le test qui tombe dessus). On warm-up :
//   • les pages publiques (/, /connexion) ;
//   • les 10 routes (app) (toutes derrière l'auth → GET non authentifié = 307 vers
//     /connexion, MAIS le 307 n'est émis qu'APRÈS compilation du segment côté serveur,
//     donc le GET déclenche bien la compilation, c'est ce qu'on veut).
// `/livraison` retiré : route inexistante (404) qui ne compilait rien d'utile.
const WARM_UP_ROUTES = [
  '/',
  '/connexion',
  '/tableau',
  '/commandes',
  '/produits',
  '/clients',
  '/finances',
  '/analyses',
  '/assistant',
  '/livreurs',
  '/boutiques',
  '/parametres',
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
        // On ATTEND la réponse complète : `get` ne résout qu'une fois la requête
        // servie (suivi des redirections inclus), donc après la compilation
        // on-demand du segment. Timeout 60s car un build à froid sous charge peut
        // dépasser 20s (vu « GET /tableau 200 in 20356ms » dans les logs CI).
        await context.get(route, { timeout: 60_000 });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) await sleep(2_000);
      }
    }
    if (lastErr) {
      // Non-fatal : un warm-up raté vaut mieux qu'un warm-up absent.
      process.stderr.write(`[warm-up] ${route} echoue apres 3 tentatives : ${String(lastErr)}\n`);
    }
  }

  await context.dispose();
}

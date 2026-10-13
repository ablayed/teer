import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { cleanupVisualFixture, createVisualFixture } from './helpers/visual-fixtures';

// Surface des Server Actions, vue de l'extérieur, sur le build de production.
//
// Next enregistre chaque fonction exportée d'un fichier `'use server'` comme un point d'entrée
// HTTP. Ce test ne suppose rien de leur liste : il lit, dans le build servi, TOUS les
// identifiants d'action enregistrés, et les appelle un par un SANS session, en leur présentant
// l'identifiant d'un utilisateur puis celui de son compte marchand. Aucune réponse ne doit
// rendre l'autre moitié de la paire : ni le compte de cet utilisateur, ni le propriétaire de ce
// compte. Une lecture service-role par identifiant, exposée comme action, rendrait l'une ou
// l'autre — c'est ce que faisaient les deux lectures déplacées dans lib/merchant/member-account.ts.
//
// Aucun identifiant d'action n'est figé ici : ils changent à chaque build.
// Build de production seulement : en développement, le manifeste n'existe pas sous cette forme.

const MANIFEST = resolve(process.cwd(), '.next/server/server-reference-manifest.json');

test.describe('Server Actions — rien de lisible sans session', () => {
  test.skip(process.env.E2E_PROD_BUILD !== '1', 'build de production uniquement');
  test.skip(
    ({ browserName }) => browserName !== 'chromium',
    'surface HTTP : un seul projet suffit',
  );

  test('aucune action ne rend le membre ni le compte d’un tiers à un appelant anonyme', async ({
    playwright,
    baseURL,
  }) => {
    test.setTimeout(5 * 60_000);
    expect(existsSync(MANIFEST), MANIFEST).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      node?: Record<string, unknown>;
    };
    const actionIds = Object.keys(manifest.node ?? {});
    // Le build de l'application enregistre des dizaines d'actions : zéro voudrait dire que le
    // test ne lit pas le bon fichier, pas que la surface est vide.
    expect(actionIds.length).toBeGreaterThan(20);

    const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
    const victim = await createVisualFixture('surface');
    const userId = victim.userIds[0];
    const accountId = victim.merchantAccountId;
    const anonymous = await playwright.request.newContext({ baseURL: origin });
    const leaks: string[] = [];
    let answered = 0;

    try {
      for (const actionId of actionIds) {
        for (const [argument, forbidden, label] of [
          [userId, accountId, 'compte rendu pour un identifiant d’utilisateur'],
          [accountId, userId, 'propriétaire rendu pour un identifiant de compte'],
        ] as const) {
          // `/parametres` : une page de l'application. L'action est résolue avant tout rendu.
          const response = await anonymous.post('/parametres', {
            data: JSON.stringify([argument]),
            headers: {
              Accept: 'text/x-component',
              'Content-Type': 'text/plain;charset=UTF-8',
              'Next-Action': actionId,
              Origin: origin,
            },
            maxRedirects: 0,
          });
          if (response.headers()['x-nextjs-action-not-found'] !== '1') answered += 1;
          const body = await response.text();
          if (body.includes(forbidden)) {
            // Jamais l'identifiant d'action dans le message : seulement son rang.
            leaks.push(`action n° ${actionIds.indexOf(actionId) + 1} : ${label}`);
          }
        }
      }
    } finally {
      await anonymous.dispose();
      await cleanupVisualFixture(victim);
    }

    // Les identifiants lus sont bien ceux du serveur en marche : des actions ont répondu.
    expect(answered).toBeGreaterThan(20);
    expect(leaks).toEqual([]);
  });
});

/**
 * Phase U — UX-DS-01, garde de vouvoiement généralisée. Complète
 * `no-tutoiement-finance-components.test.ts` (Lot U1-F, liste blanche de 11 fichiers) en
 * couvrant la source réelle des messages utilisateur traduits : `messages/fr.json`, périmètre
 * quasi total des copies d'interface définies de l'app (~65 fichiers utilisent `useTranslations`).
 *
 * Portée bornée à `messages/fr.json` (pas tout TypeScript) : une recherche générale
 * produirait des faux positifs sur les exemples, noms propres, commentaires, contenus Shopify
 * et textes techniques — voir docs/lexique-microcopie.md. `marketing.*` est explicitement HORS
 * PÉRIPHÈRE : décision du fondateur (UX-DS-01, arbitrage Temps 2) — le tutoiement y est un choix
 * de registre pour une page de vente, distinct du produit ; la règle « sans exception » porte sur
 * le produit authentifié, pas sur le contenu commercial.
 *
 * Même détecteur calibré que le Lot U1-F-bis (lookaround Unicode `\p{L}\p{N}_` au lieu de `\b`,
 * qui casse sur les accents et fait matcher "tes" dans "incomplètes"). Un test de contrôle
 * (« Confirme mais refuse souvent » — flag client à la 3e personne, pas une adresse à
 * l'utilisateur) documente une classe de faux positif connue et volontairement non couverte —
 * cette garde ne détecte que pronoms/possessifs de la 2e personne du singulier, jamais les
 * conjugaisons verbales (ex. impératif « Réessaie » vs « Réessayez »), trouvées et corrigées
 * manuellement pendant ce lot (assistant.feedback.errorBody) faute d'un détecteur fiable pour
 * cette classe sans un taux de faux positifs inacceptable.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORD = String.raw`[\p{L}\p{N}_]`;

function tutoiementPattern(): RegExp {
  return new RegExp(
    String.raw`(?<!${WORD})(tu|te|ton|ta|tes|toi)(?!${WORD})|(?<!${WORD})t['’](?=${WORD})`,
    'giu',
  );
}

type Violation = { path: string; value: string; matches: string[] };

function findTutoiementInMessages(
  tree: unknown,
  excludeTopLevelKeys: readonly string[],
): Violation[] {
  const violations: Violation[] = [];
  const pattern = tutoiementPattern();

  function walk(node: unknown, path: string[]) {
    if (typeof node === 'string') {
      const matches = [...node.matchAll(pattern)].map((m) => m[0]);
      if (matches.length > 0) {
        violations.push({ path: path.join('.'), value: node, matches });
      }
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (path.length === 0 && excludeTopLevelKeys.includes(key)) {
          continue;
        }
        walk(value, [...path, key]);
      }
    }
  }

  walk(tree, []);
  return violations;
}

describe('findTutoiementInMessages (vérification du détecteur lui-même)', () => {
  it('signale un pronom de tutoiement isolé', () => {
    const violations = findTutoiementInMessages({ a: { b: 'Décris ta suggestion' } }, []);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('a.b');
  });

  it('ne signale rien pour un mot contenant "ta"/"te"/"tes" en interne (accents, faux amis)', () => {
    const violations = findTutoiementInMessages(
      { a: 'Toutes les commandes incomplètes ont une tête' },
      [],
    );
    expect(violations).toEqual([]);
  });

  it('exclut le(s) namespace(s) demandé(s) (ex. marketing) sans regarder leur contenu', () => {
    const violations = findTutoiementInMessages(
      { marketing: { hero: 'Connecte ta boutique' }, app: { ok: 'Vous avez confirmé' } },
      ['marketing'],
    );
    expect(violations).toEqual([]);
  });

  it('ne signale pas un verbe conjugué à la 3e personne (classe de faux positif connue, non couverte)', () => {
    // Documente la limite du détecteur — cf. commentaire d'en-tête. "Confirme"/"refuse" sont
    // ici la 3e personne du singulier (le client), pas une adresse à l'utilisateur.
    const violations = findTutoiementInMessages(
      { clients: { flag: 'Confirme mais refuse souvent à la livraison.' } },
      [],
    );
    expect(violations).toEqual([]);
  });
});

describe('registre — aucun tutoiement dans messages/fr.json (hors marketing)', () => {
  it('messages/fr.json ne contient aucun marqueur de tutoiement en dehors de marketing.*', () => {
    const source = readFileSync(join(process.cwd(), 'messages', 'fr.json'), 'utf8');
    const tree = JSON.parse(source) as unknown;
    const violations = findTutoiementInMessages(tree, ['marketing']);

    expect(violations).toEqual([]);
  });
});

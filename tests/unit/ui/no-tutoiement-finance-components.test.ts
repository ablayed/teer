/**
 * Phase F — Lot U1-F-bis, preuve 1 : « Vouvoiement, sans exception. » Contrôle automatisé,
 * pas une relecture — rougit si une chaîne des composants finance du Lot U1-F (et de la page de
 * démonstration) contient un marqueur de tutoiement (tu/te/ton/ta/tes/toi/t’…).
 *
 * Calibrage anti-faux-positif (docs/lexique-microcopie.md) : un `\b` JavaScript est ASCII-only —
 * il traite un accent (è, ê, é…) comme un caractère « non-mot », ce qui casse la frontière et
 * fait matcher "tes" dans "incomplètes"/"complètes" ou "te" dans "tête". Fixé par des
 * lookaround Unicode (`\p{L}\p{N}_`) au lieu de `\b`. Calibré sur les 8 fichiers listés
 * ci-dessous (avant correctif U1-F-bis, avec « Tu as encaissé »/« t’a coûté »/« Il te reste ») :
 * 0 faux positif, 0 faux négatif — voir le script de calibrage dans le rapport de fin de lot.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FINANCE_COMPONENT_FILES = [
  'components/ui/amount.tsx',
  'components/ui/value-state.tsx',
  'components/ui/gain-loss.tsx',
  'components/ui/scoped-metric-card.tsx',
  'components/ui/explanation-card.tsx',
  'components/ui/list-card.tsx',
  'components/ui/insufficient-data-state.tsx',
  // Lot F2 — rentabilité par arrivage : mêmes primitives, même registre.
  join('components', 'purchases', 'purchase-lot-detail-panel.tsx'),
  join('components', 'purchases', 'product-ad-spend-form.tsx'),
  join('components', 'purchases', 'purchase-lots-view.tsx'),
  join('components', 'products', 'product-detail-panel.tsx'),
  // Lot F2-bis — vue arrivages de Finances et désactivation de la saisie ADS
  // dans les dépenses génériques : écrans réels qui ont remplacé la page de
  // démonstration `/dev/finance-foundations` (retirée, cf. docs/lexique-microcopie.md).
  join('app', '(app)', 'finances', 'page.tsx'),
  join('components', 'finance', 'ExpenseSection.tsx'),
];

const WORD = String.raw`[\p{L}\p{N}_]`;

function tutoiementPattern(): RegExp {
  return new RegExp(
    String.raw`(?<!${WORD})(tu|te|ton|ta|tes|toi)(?!${WORD})|(?<!${WORD})t['’](?=${WORD})`,
    'giu',
  );
}

describe('registre — aucun tutoiement dans les composants finance du Lot U1-F', () => {
  it.each(FINANCE_COMPONENT_FILES)(
    '%s ne contient aucun marqueur de tutoiement',
    (relativePath) => {
      const source = readFileSync(join(process.cwd(), relativePath), 'utf8');
      const matches = [...source.matchAll(tutoiementPattern())].map((m) => m[0]);

      expect(matches).toEqual([]);
    },
  );
});

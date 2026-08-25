import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 2 / Lot L2 — preuve #4 (frontière d'imports) : un module adaptateur ne peut PAS écrire.
// Le typage (ResolvedConnectionContext brandé, lib/ingestion/canonical.ts) prouve l'API ; ce test
// prouve l'ABSENCE d'accès caché — le typage ne peut pas empêcher un module d'importer un client
// Supabase global, seule une frontière d'imports explicite le peut.
//
// Modules couverts : tout ce qui compose le contrat PlatformConnector côté "adaptateur" (jamais la
// couche applicative de résolution/écriture, qui EST autorisée à importer Supabase).
const ADAPTER_MODULES = ['lib/ingestion/canonical.ts', 'lib/shopify/adapter.ts'];

// Interdit : tout import de Supabase, d'une Server Action, ou d'un repository/écriture connu du
// projet. Volontairement une allowlist de motifs plutôt qu'un parseur AST — cohérent avec le style
// déjà retenu pour tests/unit/security/lot4a-migration-revoke-pairing.test.ts (contrôle textuel
// calibré, pas une garantie de typage).
const FORBIDDEN_IMPORT_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /@supabase\/supabase-js/, label: '@supabase/supabase-js' },
  { pattern: /@\/lib\/supabase\/(server|client)/, label: 'lib/supabase/server|client' },
  { pattern: /^\s*['"]use server['"]\s*;?\s*$/m, label: "'use server' directive" },
  { pattern: /@\/lib\/actions\//, label: 'lib/actions/* (Server Actions)' },
  {
    pattern: /@\/lib\/ingestion\/(resolve-connection|dual-write|shopify-dual-write)/,
    label: 'lib/ingestion write layer',
  },
];

describe("Lot L2 — frontière d'imports de l'adaptateur PlatformConnector", () => {
  it('sanity : la liste de modules adaptateur est non vide', () => {
    expect(ADAPTER_MODULES.length).toBeGreaterThan(0);
  });

  for (const modulePath of ADAPTER_MODULES) {
    it(`${modulePath} n'importe aucun module d'écriture`, () => {
      const content = readFileSync(resolve(process.cwd(), modulePath), 'utf8');
      const violations = FORBIDDEN_IMPORT_PATTERNS.filter(({ pattern }) =>
        pattern.test(content),
      ).map(({ label }) => label);
      expect(violations).toEqual([]);
    });
  }
});

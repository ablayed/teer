import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Phase 2 / Lot 4B — preuve complémentaire du cas 2 : AUTHENTIFICATION refusée,
// distincte de CONNEXION refusée (déjà couverte, port fermé, dans
// tests/unit/security/acl-production-probe.test.ts). Un port fermé prouve
// qu'une socket est fermée, pas qu'un mot de passe est rejeté — et sur ce
// chemin-là la chaîne de connexion n'a jamais réellement servi à s'authentifier
// contre un serveur réel. `password authentication failed` est le cas le plus
// fréquent où un driver Postgres réintroduit la chaîne de connexion complète
// dans son message d'erreur — c'est le chemin qui compte pour la non-fuite.
//
// Cible : le Postgres LOCAL du stack `supabase start` de ce dépôt (jamais la
// production), avec un mot de passe délibérément faux contre le rôle réel
// `postgres`. Vivant dans tests/rls (pas tests/unit) car il exige un serveur
// Postgres réellement démarré — même garde `skipIf` que le reste de ce
// répertoire, jamais exécuté sans stack local (donc jamais en CI test-unit).

const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const PROBE_SCRIPT = resolve(PROJECT_ROOT, 'scripts/acl-production-probe.mjs');

const hasEnv = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);

describe.skipIf(!hasEnv)(
  'Lot 4B — cas 2b : authentification refusée (cible locale réelle, mot de passe faux)',
  () => {
    it('échoue proprement et ne fuite jamais la chaîne de connexion, y compris le mot de passe faux', () => {
      const wrongPassword = 'definitely-not-the-real-local-password-9f3c1a';
      const env = {
        ...process.env,
        CI_SCHEMA_AUDITOR_DB_URL: `postgresql://postgres:${wrongPassword}@127.0.0.1:54322/postgres`,
      };

      const result = spawnSync('node', [PROBE_SCRIPT], {
        cwd: PROJECT_ROOT,
        env,
        encoding: 'utf8',
        timeout: 20_000,
      });

      expect(result.status).toBe(1);
      const combined = `${result.stdout}${result.stderr}`;

      // Preuve que ce chemin a RÉELLEMENT rejeté une authentification (serveur
      // réel joignable, identifiants refusés) — pas un port fermé déguisé.
      expect(combined.toLowerCase()).toMatch(
        /password authentication failed|authentification.*mot de passe|28p01/,
      );

      expect(combined).not.toContain(wrongPassword);
      expect(combined).not.toContain(`postgres:${wrongPassword}`);
      expect(combined).not.toMatch(/postgres(?:ql)?:\/\/[^\s]*definitely-not/);
    });
  },
);

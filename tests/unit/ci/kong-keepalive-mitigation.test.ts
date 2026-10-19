import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

const SCRIPT = 'scripts/ci-disable-kong-upstream-keepalive.sh';
const STEP_NAME = 'Désactive la réutilisation des connexions kong → PostgREST (pile de test)';

// Corps du job `test-rls` : de son en-tête jusqu'au prochain job de premier niveau.
function testRlsJob(workflow: string): string {
  const start = workflow.indexOf('\n  test-rls:\n');
  expect(start).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice('  test-rls:\n'.length).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, '  test-rls:\n'.length + next);
}

describe('mitigation kong → PostgREST de la pile de test (réutilisation des connexions)', () => {
  it('le script désactive le pool amont ET échoue si le rechargement n’est pas effectif', () => {
    const script = read(SCRIPT);

    expect(script).toContain('KONG_UPSTREAM_KEEPALIVE_POOL_SIZE=0');
    expect(script).toContain('kong reload');
    // Relit la configuration EFFECTIVE de kong, jamais l’intention.
    expect(script).toContain('/usr/local/kong/.kong_env');
    expect(script).toContain("expected='upstream_keepalive_pool_size=0'");
    // L’échec est porté par le bloc de la comparaison lui-même, pas par un `exit 1` plus loin.
    expect(script).toMatch(
      /if \[\[ "\$effective" != "\$expected" \]\]; then[\s\S]*?\n {2}exit 1\nfi/,
    );
    // Aucun succès silencieux : la santé de la passerelle est aussi vérifiée.
    expect(script).toContain('/auth/v1/health');
    expect(script).toMatch(/set -euo pipefail/);
  });

  it('le job test-rls l’exécute après le démarrage de Supabase et avant les tests RLS', () => {
    const job = testRlsJob(read('.github/workflows/ci.yml'));

    const start = job.indexOf('Start Supabase (sanitized diagnostics)');
    const step = job.indexOf(STEP_NAME);
    const tests = job.indexOf('- run: pnpm test:rls');

    expect(start).toBeGreaterThan(-1);
    expect(step).toBeGreaterThan(start);
    expect(tests).toBeGreaterThan(step);
    expect(job).toContain(`run: bash ${SCRIPT}`);
  });

  it('la mitigation ne concerne que le job test-rls (portée du défaut mesuré)', () => {
    const workflow = read('.github/workflows/ci.yml');

    expect(workflow.split(`bash ${SCRIPT}`).length - 1).toBe(1);
  });
});

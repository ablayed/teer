import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

// PostgREST v14.15 répond `Connection: close` à un HEAD sans Content-Length. Avant, il fermait la
// connexion sans le dire : Kong la remettait dans son pool et le POST/PATCH suivant, non relançable,
// recevait un 502 (supabase/cli#6674). La CLI lit ce fichier et ne remplace que l'image PostgREST.
describe('épinglage de PostgREST (supabase/.temp/rest-version)', () => {
  it('le fichier existe, au format attendu, sans retour à la ligne, à v14.15 au moins', () => {
    const raw = read('supabase/.temp/rest-version');

    expect(raw).toMatch(/^v\d+\.\d+$/); // la CLI exige l'absence de retour à la ligne final
    const [, major, minor] = raw.match(/^v(\d+)\.(\d+)$/) ?? [];
    const version = Number(major) * 1000 + Number(minor);
    expect(version).toBeGreaterThanOrEqual(14 * 1000 + 15);
  });

  it('.gitignore laisse suivre ce fichier (sinon la CI ne l’aurait jamais)', () => {
    const lines = read('.gitignore').split('\n');

    expect(lines).toContain('supabase/.temp/*');
    expect(lines).toContain('!supabase/.temp/rest-version');
    // L'exception vient APRÈS la règle générale, sans quoi elle ne s'appliquerait pas.
    expect(lines.indexOf('!supabase/.temp/rest-version')).toBeGreaterThan(
      lines.indexOf('supabase/.temp/*'),
    );
  });

  it('le démarrage commun de la CI échoue si l’image lancée n’est pas celle de l’épinglage', () => {
    const script = read('scripts/ci-start-supabase-with-diagnostics.sh');

    expect(script).toContain('supabase/.temp/rest-version');
    expect(script).toContain("--filter 'name=supabase_rest_'");
    expect(script).toMatch(/"\$\{running_rest##\*:\}" != "\$pinned_rest"[\s\S]*status=1/);
  });
});

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

// Run 39940752057 : au même instant, 117 Mo de paquets WebKit sont servis en 9 à 12 s sur la plupart
// des runners, et à ~40 Ko/s sur trois autres, qui restent lents d'une tentative à l'autre sur le
// miroir `azure.archive.ubuntu.com`. Refaire la même tentative ne change rien : il faut la couper
// vite, puis changer de miroir.
describe('installation Playwright en CI', () => {
  const workflow = read('.github/workflows/ci.yml');
  const steps = [
    ...workflow.matchAll(
      /- name: Install Playwright browsers and deps\n([\s\S]*?)(?=\n {6}- (?:name|uses):)/g,
    ),
  ].map((match) => match[1]);

  it('les quatre jobs navigateur passent par le script commun, sans boucle recopiée', () => {
    expect(steps).toHaveLength(4);
    for (const step of steps) {
      expect(step).toContain('bash scripts/ci-install-playwright.sh');
      expect(step).not.toContain('pnpm exec playwright install');
      expect(step).not.toContain('setsid');
    }
  });

  it('chaque job n’installe que son moteur ; seul le visuel mobile exécute les deux', () => {
    const calls = steps.map((step) => step.match(/ci-install-playwright\.sh (.+)/)?.[1]);

    expect(calls).toEqual(['"${browsers[@]}"', '"${browsers[@]}"', 'chromium', 'chromium webkit']);
    // Phase 1 et régression : webkit pour iphone-14 seulement, chromium sinon.
    for (const step of steps.slice(0, 2)) {
      expect(step).toContain('browsers=(chromium)');
      expect(step).toMatch(/"iphone-14"[\s\S]*browsers=\(webkit\)/);
    }
  });

  it('le plafond de l’étape couvre trois tentatives, pas vingt-six minutes', () => {
    for (const step of steps) {
      expect(step).toMatch(/timeout-minutes: 12\b/);
    }
  });

  it('le script coupe une tentative lente et change de miroir officiel', () => {
    const script = read('scripts/ci-install-playwright.sh');

    expect(script).toContain('PW_INSTALL_ATTEMPT_TIMEOUT:-120');
    expect(script).toContain('https://archive.ubuntu.com/ubuntu/');
    expect(script).toContain('https://mirrors.edge.kernel.org/ubuntu/');
    expect(script).toContain('Acquire::http::Timeout');
    expect(script).toContain('setsid');
    // Le message final ne réduit plus deux causes opposées à « stall ».
    expect(script).not.toContain('stall persistant');
    expect(script).toContain('Hash Sum mismatch');
  });
});

// `setsid` et `kill -- -PGID` n'existent pas sous Windows : le comportement se prouve sur Linux (CI).
describe.skipIf(process.platform === 'win32')(
  'scripts/ci-install-playwright.sh (comportement)',
  () => {
    const run = (stub: string, timeoutSeconds = 1) => {
      const dir = mkdtempSync(join(tmpdir(), 'pw-install-'));
      const mirrors = join(dir, 'apt-mirrors.txt');
      const stubFile = join(dir, 'stub.sh');
      writeFileSync(mirrors, 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n');
      writeFileSync(stubFile, stub);
      const result = spawnSync('bash', [resolve('scripts/ci-install-playwright.sh'), 'webkit'], {
        encoding: 'utf8',
        timeout: 60_000,
        env: {
          ...process.env,
          PW_INSTALL_CMD: `bash ${stubFile}`,
          PW_INSTALL_SUDO: 'env',
          PW_INSTALL_ATTEMPT_TIMEOUT: String(timeoutSeconds),
          PW_INSTALL_RETRY_PAUSE: '0',
          PW_APT_MIRRORS_FILE: mirrors,
          PW_APT_CONF_FILE: join(dir, '80-ci-network'),
        },
      });
      return {
        ...result,
        mirrors: readFileSync(mirrors, 'utf8'),
        conf: read(join(dir, '80-ci-network')),
      };
    };

    it('réussit à la première tentative sans toucher au miroir', () => {
      const result = run('exit 0\n');

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('réussi à la tentative 1');
      expect(result.mirrors).toContain('azure.archive.ubuntu.com');
      expect(result.conf).toContain('Acquire::Retries "3"');
    });

    it('coupe un miroir lent puis réussit sur le miroir officiel de repli', () => {
      const result = run(
        [
          'if grep -qE "^https://archive\\.ubuntu\\.com/" "$PW_APT_MIRRORS_FILE"; then exit 0; fi',
          'sleep 30',
        ].join('\n'),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'Tentative 2 : bascule sur le miroir officiel https://archive.ubuntu.com/ubuntu/',
      );
      expect(result.stdout).toContain('réussi à la tentative 2');
    });

    it('échoue après trois tentatives, en ayant essayé les deux miroirs de repli', () => {
      const result = run('sleep 30\n');

      expect(result.status).toBe(1);
      expect(result.mirrors).toContain('https://mirrors.edge.kernel.org/ubuntu/');
      expect(result.stdout).toContain('Tentative 3 : bascule sur le miroir officiel');
      expect(result.stdout).toContain('a échoué 3 fois de suite');
    });
  },
);

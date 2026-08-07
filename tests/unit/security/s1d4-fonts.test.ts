import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

describe('S1D-4 deterministic local fonts', () => {
  it('self-hosts Fraunces and preserves the existing CSS variables', () => {
    const layout = read('app/layout.tsx');
    const globals = read('app/globals.css');
    const fontCss = `${read('node_modules/@fontsource-variable/fraunces/wght.css')}\n${read(
      'node_modules/@fontsource-variable/fraunces/wght-italic.css',
    )}`;
    const fontPackage = JSON.parse(
      read('node_modules/@fontsource-variable/fraunces/package.json'),
    ) as { license?: string };

    expect(layout).not.toContain('next/font/google');
    expect(layout).toContain('@fontsource-variable/fraunces/wght.css');
    expect(layout).toContain('@fontsource-variable/fraunces/wght-italic.css');
    expect(globals).toContain('--font-fraunces: "Fraunces Variable"');
    expect(globals).toContain('--font-fraunces-italic: "Fraunces Variable"');
    expect(fontCss).toContain('@font-face');
    expect(fontCss).not.toMatch(/https?:\/\//);
    expect(fontPackage.license).toBe('OFL-1.1');
  });

  it('does not retain Google Fonts endpoints in the application source', () => {
    for (const file of ['app/layout.tsx', 'app/globals.css', 'next.config.mjs']) {
      expect(read(file), file).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/);
    }
  });
});

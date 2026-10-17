import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('traces serveur et Edge suspendues — configuration', () => {
  it.each(['sentry.server.config.ts', 'sentry.edge.config.ts'])(
    '%s : échantillonneur à 0, aucun taux fixe, erreurs expurgées conservées',
    (file) => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toContain('tracesSampler: () => 0,');
      expect(source).not.toMatch(/tracesSampleRate/);
      expect(source).toContain('beforeSend: (event) => sanitizeSentryEvent(event),');
    },
  );
});

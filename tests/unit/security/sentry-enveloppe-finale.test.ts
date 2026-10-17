import { sanitizeSentryServerTransaction } from '@/lib/security/telemetry-sanitize-server';
import { expect, it } from 'vitest';
import { enveloppesFinales } from '../../helpers/sentry-enveloppe-finale';
import { CANARIS_A_ABSENTS } from '../../helpers/sentry-transaction-canaris';

it('enveloppe finale : une transaction émise par le SDK ne contient aucune valeur fictive sensible', async () => {
  const enveloppes = await enveloppesFinales(sanitizeSentryServerTransaction);
  expect(enveloppes).toHaveLength(1);
  for (const canari of CANARIS_A_ABSENTS) expect(enveloppes[0]).not.toContain(canari);
  expect(enveloppes[0]).toContain('GET /s/[storeId]/commandes');
});

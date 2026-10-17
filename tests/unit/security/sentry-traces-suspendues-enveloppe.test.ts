import { expect, it } from 'vitest';
import { typesEnveloppes } from '../../helpers/sentry-enveloppes';

it('avec la configuration retenue, une trace entrante déjà échantillonnée n’émet aucune transaction', async () => {
  const types = await typesEnveloppes({ tracesSampler: () => 0 }, true);
  expect(types).not.toContain('transaction');
  expect(types).toContain('event');
});

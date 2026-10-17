import { expect, it } from 'vitest';
import { typesEnveloppes } from '../../helpers/sentry-enveloppes';

// Témoin : sans la suspension, la même trace émet bien une transaction. Il prouve que le test
// d'à côté sait voir ce qu'il garde.
it('témoin : un taux fixe de 1 émet la transaction', async () => {
  const types = await typesEnveloppes({ tracesSampleRate: 1 }, true);
  expect(types).toContain('transaction');
});

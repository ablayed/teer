import { expect, it } from 'vitest';
import { enveloppesFinales } from '../../helpers/sentry-enveloppe-finale';
import { CANARIS } from '../../helpers/sentry-transaction-canaris';

// Témoin : sans nettoyeur, le même scénario laisse partir cookies, en-têtes et requête. Il prouve
// que le test d'à côté sait voir ces valeurs quand elles existent.
it('témoin : sans nettoyeur, les valeurs fictives des cookies, en-têtes et requêtes sont dans l’enveloppe', async () => {
  const enveloppes = await enveloppesFinales();
  expect(enveloppes).toHaveLength(1);
  for (const canari of [
    CANARIS.cookie,
    CANARIS.entete,
    CANARIS.ip,
    CANARIS.requete,
    CANARIS.filtre,
  ]) {
    expect(enveloppes[0]).toContain(canari);
  }
});

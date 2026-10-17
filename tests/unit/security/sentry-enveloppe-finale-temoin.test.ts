import { expect, it } from 'vitest';
import { enveloppesFinales } from '../../helpers/sentry-enveloppe-finale';
import { CANARIS } from '../../helpers/sentry-transaction-canaris';

// Témoin : sans nettoyeur, le même scénario laisse partir cookies, en-têtes et requête. Il prouve
// que le test d'à côté sait voir ces valeurs quand elles existent.
//
// Sentry 10 filtre de lui-même `x-forwarded-for` (valeur `[Filtered]`) : l'adresse IP n'est plus
// observable par ce témoin. Le nettoyeur la retire malgré tout (tests du nettoyeur) ; ici on
// constate seulement que le SDK ne la laisse plus partir.
it('témoin : sans nettoyeur, les valeurs fictives des cookies, en-têtes et requêtes sont dans l’enveloppe', async () => {
  const enveloppes = await enveloppesFinales();
  expect(enveloppes).toHaveLength(1);
  for (const canari of [CANARIS.cookie, CANARIS.entete, CANARIS.requete, CANARIS.filtre]) {
    expect(enveloppes[0]).toContain(canari);
  }
  expect(enveloppes[0]).not.toContain(CANARIS.ip);
});

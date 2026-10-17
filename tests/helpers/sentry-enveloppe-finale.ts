import * as Sentry from '@sentry/nextjs';
import { CANARIS } from './sentry-transaction-canaris';

// Émet UNE transaction par le vrai SDK, avec l'intégration de données de requête active (son
// réglage par défaut collecte cookies, en-têtes et chaîne de requête) et des valeurs fictives
// reconnaissables dans chaque canal. Retourne le texte brut de chaque enveloppe réellement remise
// au transport, après `beforeSendTransaction`. Un scénario par fichier de test : le SDK installe un
// fournisseur OpenTelemetry global.
export async function enveloppesFinales(beforeSendTransaction?: (event: never) => unknown) {
  const textes: string[] = [];
  Sentry.init({
    dsn: 'https://cle@exemple.invalid/1',
    defaultIntegrations: false,
    integrations: [Sentry.requestDataIntegration()],
    tracesSampleRate: 1,
    ...(beforeSendTransaction ? { beforeSendTransaction: beforeSendTransaction as never } : {}),
    transport: () => ({
      send: async (envelope: [unknown, [unknown, unknown][]]) => {
        textes.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }),
  });
  Sentry.getIsolationScope().setSDKProcessingMetadata({
    normalizedRequest: {
      method: 'GET',
      url: `https://www.exemple.test/s/${CANARIS.identifiant}/commandes?q=${CANARIS.requete}`,
      query_string: `q=${CANARIS.requete}`,
      cookies: { 'sb-projet-auth-token': CANARIS.cookie },
      headers: {
        cookie: `sb-projet-auth-token=${CANARIS.cookie}`,
        'x-forwarded-for': CANARIS.ip,
        'user-agent': CANARIS.agent,
        'x-perso': CANARIS.entete,
      },
    },
  });
  Sentry.startSpan(
    {
      name: `GET /s/${CANARIS.identifiant}/commandes`,
      op: 'http.server',
      attributes: {
        'http.route': '/s/[storeId]/commandes',
        'http.request.method': 'GET',
        'http.target': `/s/${CANARIS.identifiant}/commandes?q=${CANARIS.requete}`,
        'url.query': `?q=${CANARIS.requete}`,
        'user_agent.original': CANARIS.agent,
      },
    },
    () => {
      Sentry.startSpan(
        {
          name: `GET http://${CANARIS.hote}/rest/v1/orders?phone=eq.${CANARIS.filtre}`,
          op: 'http.client',
          attributes: {
            'url.full': `http://${CANARIS.hote}/rest/v1/orders?phone=eq.${CANARIS.filtre}`,
          },
        },
        () => {},
      );
    },
  );
  await Sentry.flush(2000);
  await Sentry.close();
  return textes.filter((t) => t.includes('"transaction"'));
}

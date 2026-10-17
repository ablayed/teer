// Valeurs FICTIVES, reconnaissables, jamais des secrets réels : elles servent à prouver qu'aucune
// valeur de ces canaux ne subsiste dans l'événement final.
export const CANARIS = {
  cookie: 'CANARI-COOKIE-SESSION',
  entete: 'CANARI-ENTETE-PERSO',
  ip: '203.0.113.77',
  requete: 'CANARI-RECHERCHE-CLIENT',
  filtre: 'CANARI-FILTRE-POSTGREST',
  identifiant: '153f488c-0ba7-40af-806a-d6933fcfa69b',
  agent: 'CANARI-AGENT-UTILISATEUR',
  hote: 'canari-boutique.example',
} as const;

export const CANARIS_A_ABSENTS = Object.values(CANARIS);

const TRACE_ID = 'a'.repeat(32);

// Forme mesurée sur un build de production local (21 transactions) : nom brut, source `url`,
// requête complète, attributs d'URL, spans d'appels sortants à filtres.
export function transactionServeurBrute() {
  return {
    type: 'transaction',
    transaction: `GET /s/${CANARIS.identifiant}/commandes`,
    transaction_info: { source: 'url' },
    event_id: 'c'.repeat(32),
    platform: 'node',
    environment: 'perf-test',
    release: 'rel-1',
    server_name: CANARIS.hote,
    start_timestamp: 1_700_000_000.1,
    timestamp: 1_700_000_000.9,
    request: {
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
      data: { corps: CANARIS.requete },
    },
    user: { ip_address: CANARIS.ip },
    breadcrumbs: [{ message: CANARIS.requete }],
    contexts: {
      trace: {
        trace_id: TRACE_ID,
        span_id: 'b'.repeat(16),
        op: 'http.server',
        status: 'ok',
        origin: 'auto.http.otel.http',
        data: {
          'sentry.op': 'http.server',
          'sentry.origin': 'auto.http.otel.http',
          'sentry.source': 'url',
          'http.route': '/s/[storeId]/commandes',
          'http.request.method': 'GET',
          'http.response.status_code': 200,
          'http.target': `/s/${CANARIS.identifiant}/commandes?q=${CANARIS.requete}`,
          'http.query': `?q=${CANARIS.requete}`,
          'url.full': `https://www.exemple.test/s/${CANARIS.identifiant}/commandes?q=${CANARIS.requete}`,
          'url.query': `?q=${CANARIS.requete}`,
          'user_agent.original': CANARIS.agent,
          'server.address': CANARIS.hote,
        },
      },
      cloud_resource: { 'cloud.region': CANARIS.hote },
    },
    spans: [
      {
        span_id: 'd'.repeat(16),
        trace_id: TRACE_ID,
        parent_span_id: 'b'.repeat(16),
        start_timestamp: 1_700_000_000.2,
        timestamp: 1_700_000_000.4,
        op: 'http.client',
        description: `GET http://${CANARIS.hote}:54321/rest/v1/orders?select=id&phone=eq.${CANARIS.filtre}`,
        data: {
          'http.request.method': 'GET',
          'url.full': `http://${CANARIS.hote}/rest/v1/orders?phone=eq.${CANARIS.filtre}`,
          'url.query': `?phone=eq.${CANARIS.filtre}`,
          'http.response.status_code': 200,
        },
      },
      {
        span_id: 'e'.repeat(16),
        trace_id: TRACE_ID,
        op: 'function.nextjs',
        description: 'Page Server Component (/(app)/s/[storeId]/commandes)',
        data: { 'next.route': '/s/[storeId]/commandes' },
      },
      {
        span_id: 'f'.repeat(16),
        trace_id: TRACE_ID,
        op: 'http.client',
        description: `POST https://api.exemple.test/admin/orders/${CANARIS.identifiant}.json?token=${CANARIS.filtre}`,
        data: {},
      },
    ],
  };
}

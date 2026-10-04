// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C8 — le secret du jeton L3, porté par le chemin de l'URL
// d'ingestion, ne sort ni par un événement d'erreur ni par une transaction Sentry.
//
// Couche : unitaire, fonctions pures, plus un verrou sur le câblage des deux configurations
// serveur. Le jeton est synthétique, généré à l'exécution.
//
// Ce que ces tests ne couvrent pas, et ne peuvent pas couvrir : les journaux de requêtes de la
// plateforme d'hébergement, qui enregistrent le chemin hors de ce code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateWebhookToken } from '@/lib/ingestion/webhook-token';
import {
  maskOpaqueIngestPath,
  sanitizeSentryEvent,
  sanitizeSentryTransaction,
} from '@/lib/security/telemetry-sanitize';
import { describe, expect, it } from 'vitest';

const token = generateWebhookToken();
const PATH = `/api/shopify/ingest/${token.raw}`;
const URL_WITH_TOKEN = `https://synthetic-test-webhooks.example.test${PATH}`;

function expectNoToken(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(token.secret);
  expect(serialized).not.toContain(token.publicId);
}

describe('événement d’ERREUR — sanitizeSentryEvent', () => {
  it('réduit le segment de jeton à :id et ne laisse le secret nulle part', () => {
    const safe = sanitizeSentryEvent({
      message: `échec sur ${URL_WITH_TOKEN}`,
      transaction: `POST ${PATH}`,
      request: { method: 'post', url: URL_WITH_TOKEN, headers: { referer: URL_WITH_TOKEN } },
      exception: { values: [{ type: 'error', value: `boom ${PATH}` }] },
      breadcrumbs: [{ category: 'http', message: PATH, data: { url: URL_WITH_TOKEN } }],
      extra: { pathname: PATH, autre: URL_WITH_TOKEN },
      tags: { url: PATH },
    });

    expect(safe.request?.url).toBe('/api/shopify/ingest/:id');
    expectNoToken(safe);
  });
});

describe('TRANSACTION — sanitizeSentryTransaction', () => {
  const transaction = {
    type: 'transaction',
    transaction: `POST ${PATH}`,
    request: { method: 'POST', url: URL_WITH_TOKEN, headers: { host: 'example.test' } },
    contexts: {
      trace: {
        op: 'http.server',
        data: {
          'http.target': PATH,
          'http.url': URL_WITH_TOKEN,
          'url.full': URL_WITH_TOKEN,
          'url.path': PATH,
          'http.status_code': 200,
        },
      },
    },
    spans: [
      { description: `POST ${PATH}`, data: { 'http.target': PATH, nested: { route: PATH } } },
      { description: 'select orders', data: { 'db.system': 'postgresql' } },
    ],
    tags: { route: PATH },
    measurements: { duration: 42 },
  };

  it('masque le segment de jeton PARTOUT : nom, requête, contexte de trace, spans', () => {
    const safe = sanitizeSentryTransaction(transaction);

    expectNoToken(safe);
    expect(safe.transaction).toBe('POST /api/shopify/ingest/:token');
    expect(safe.request.url).toBe(
      'https://synthetic-test-webhooks.example.test/api/shopify/ingest/:token',
    );
    expect(safe.contexts.trace.data['http.target']).toBe('/api/shopify/ingest/:token');
    expect(safe.contexts.trace.data['url.full']).toContain('/api/shopify/ingest/:token');
    expect(safe.spans[0].data.nested?.route).toBe('/api/shopify/ingest/:token');
  });

  it('contrôle positif : tout le reste de la transaction est transmis tel quel', () => {
    const safe = sanitizeSentryTransaction(transaction);

    expect(safe.type).toBe('transaction');
    expect(safe.request.method).toBe('POST');
    expect(safe.contexts.trace.op).toBe('http.server');
    expect(safe.contexts.trace.data['http.status_code']).toBe(200);
    expect(safe.spans[1]).toEqual(transaction.spans[1]);
    expect(safe.measurements).toEqual({ duration: 42 });
    // L'événement d'origine n'est pas modifié.
    expect(transaction.request.url).toBe(URL_WITH_TOKEN);
  });

  it('ne touche pas une autre route', () => {
    const other = {
      transaction: 'GET /api/orders/search',
      request: { url: '/api/orders/search?q=x' },
    };
    expect(sanitizeSentryTransaction(other)).toEqual(other);
  });

  it('au-delà de la profondeur bornée, rien n’est transmis plutôt que transmis non masqué', () => {
    let deep: Record<string, unknown> = { leaf: PATH };
    for (let level = 0; level < 20; level += 1) {
      deep = { child: deep };
    }
    expectNoToken(sanitizeSentryTransaction(deep));
  });
});

describe('maskOpaqueIngestPath', () => {
  it('masque le segment jusqu’à la fin du chemin, sans avaler la requête ni le fragment', () => {
    expect(maskOpaqueIngestPath(`${PATH}?x=1`)).toBe('/api/shopify/ingest/:token?x=1');
    expect(maskOpaqueIngestPath(`${PATH}#f`)).toBe('/api/shopify/ingest/:token#f');
    expect(maskOpaqueIngestPath(`a ${PATH} b ${PATH}`)).toBe(
      'a /api/shopify/ingest/:token b /api/shopify/ingest/:token',
    );
  });
});

describe('câblage — les deux configurations serveur filtrent les transactions', () => {
  it.each(['sentry.server.config.ts', 'sentry.edge.config.ts'])(
    '%s déclare beforeSendTransaction avec sanitizeSentryTransaction',
    (file) => {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).toContain(
        'beforeSendTransaction: (event) => sanitizeSentryTransaction(event),',
      );
      expect(source).toContain('beforeSend: (event) => sanitizeSentryEvent(event),');
    },
  );
});

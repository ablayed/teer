import { sanitizeSentryServerTransaction } from '@/lib/security/telemetry-sanitize-server';
import { describe, expect, it } from 'vitest';
import {
  CANARIS,
  CANARIS_A_ABSENTS,
  transactionServeurBrute,
} from '../../helpers/sentry-transaction-canaris';

type SpanSortie = { description: string; data: Record<string, unknown> };
type Sortie = {
  transaction: string;
  transaction_info: unknown;
  request: Record<string, unknown>;
  contexts: Record<string, unknown> & { trace: { data: Record<string, unknown> } };
  spans: SpanSortie[];
};

function nettoyee() {
  const out = sanitizeSentryServerTransaction(transactionServeurBrute());
  if (!out) throw new Error('transaction abandonnée');
  return out as unknown as Sortie;
}

describe('transactions serveur — liste blanche', () => {
  it('aucune valeur fictive des canaux sensibles ne subsiste', () => {
    const texte = JSON.stringify(nettoyee());
    for (const canari of CANARIS_A_ABSENTS) expect(texte).not.toContain(canari);
  });

  it('la requête se réduit à la méthode et à la route paramétrée', () => {
    const out = nettoyee();
    expect(out.request).toEqual({ method: 'GET', url: '/s/[storeId]/commandes' });
    expect(out.transaction).toBe('GET /s/[storeId]/commandes');
    expect(out.transaction_info).toEqual({ source: 'route' });
    for (const cle of [
      'headers',
      'cookies',
      'query_string',
      'data',
      'user',
      'breadcrumbs',
      'server_name',
    ]) {
      expect(out).not.toHaveProperty(cle);
      expect(out.request).not.toHaveProperty(cle);
    }
  });

  it('les attributs d’URL, de requête et d’agent sont retirés de la trace et des spans', () => {
    const out = nettoyee();
    const cles = [
      ...Object.keys(out.contexts.trace.data),
      ...out.spans.flatMap((s: SpanSortie) => Object.keys(s.data)),
    ];
    for (const interdite of [
      'http.target',
      'http.query',
      'url.full',
      'url.query',
      'user_agent.original',
      'server.address',
    ]) {
      expect(cles).not.toContain(interdite);
    }
    expect(out.contexts).not.toHaveProperty('cloud_resource');
    expect(out.contexts.trace.data['http.response.status_code']).toBe(200);
  });

  it('un appel sortant garde méthode et chemin généralisé, sans hôte ni requête', () => {
    const descriptions = nettoyee().spans.map((s: SpanSortie) => s.description);
    expect(descriptions[0]).toBe('GET /rest/v1/orders');
    expect(descriptions[1]).toBe('Page Server Component (/(app)/s/[storeId]/commandes)');
    expect(descriptions[2]).toBe('POST /admin/orders/:id');
  });

  it('une description de span à identifiant est remplacée par l’opération', () => {
    const brute = transactionServeurBrute();
    brute.spans[1].description = 'Page /s/153f488c-0ba7-40af-806a-d6933fcfa69b/x';
    const out = sanitizeSentryServerTransaction(brute) as unknown as Sortie;
    expect(out.spans[1].description).toBe('function.nextjs');
  });

  it('sans route paramétrée sûre, la transaction est abandonnée (jamais de repli sur le chemin brut)', () => {
    const brute = transactionServeurBrute();
    Reflect.deleteProperty(brute.contexts.trace.data, 'http.route');
    brute.transaction = `GET /s/${'x'.repeat(10)}?q=1`;
    expect(sanitizeSentryServerTransaction(brute)).toBeNull();
  });

  it('une route de repli lue dans le nom reste acceptée si elle est paramétrée', () => {
    const brute = transactionServeurBrute();
    Reflect.deleteProperty(brute.contexts.trace.data, 'http.route');
    brute.transaction = 'GET /s/[storeId]/produits';
    brute.transaction_info = { source: 'route' };
    const out = sanitizeSentryServerTransaction(brute) as unknown as Sortie;
    expect(out.request.url).toBe('/s/[storeId]/produits');
  });

  it('le masquage du jeton d’ingestion est préservé', () => {
    const brute = transactionServeurBrute();
    brute.contexts.trace.data['http.route'] = '/api/shopify/ingest/[token]';
    brute.spans[0].description = 'GET /api/shopify/ingest/pub.SECRET-FICTIF';
    const out = JSON.stringify(sanitizeSentryServerTransaction(brute));
    expect(out).not.toContain('SECRET-FICTIF');
  });

  it('un nom brut (source « url ») sans route fournie est abandonné, même sans chaîne de requête', () => {
    const brute = transactionServeurBrute();
    Reflect.deleteProperty(brute.contexts.trace.data, 'http.route');
    brute.transaction = `GET /s/${CANARIS.identifiant}/commandes`;
    expect(sanitizeSentryServerTransaction(brute)).toBeNull();
  });

  it('une clé hors liste blanche est retirée même si sa valeur paraît sûre', () => {
    const brute = transactionServeurBrute();
    Object.assign(brute.contexts.trace.data, {
      'http.target': 'commandes',
      'url.query': 'commandes',
    });
    const cles = Object.keys(
      (sanitizeSentryServerTransaction(brute) as unknown as Sortie).contexts.trace.data,
    );
    expect(cles).not.toContain('http.target');
    expect(cles).not.toContain('url.query');
  });

  it('un segment de jeton en minuscules est masqué dans un appel sortant', () => {
    const brute = transactionServeurBrute();
    brute.spans[0].description =
      'POST https://webhooks.exemple.test/api/shopify/ingest/jetonfictifminuscule';
    const out = JSON.stringify(sanitizeSentryServerTransaction(brute));
    expect(out).not.toContain('jetonfictifminuscule');
    expect(out).toContain('/api/shopify/ingest/:token');
  });

  it('un nom à mots simples de source « url » n’est pas pris pour une route', () => {
    const brute = transactionServeurBrute();
    Reflect.deleteProperty(brute.contexts.trace.data, 'http.route');
    brute.transaction = 'GET /s/boutique/commandes';
    expect(sanitizeSentryServerTransaction(brute)).toBeNull();
  });

  it('une route portant un identifiant est refusée même si elle se dit « route »', () => {
    const brute = transactionServeurBrute();
    Reflect.deleteProperty(brute.contexts.trace.data, 'http.route');
    brute.transaction = `GET /s/${CANARIS.identifiant}/commandes`;
    brute.transaction_info = { source: 'route' };
    expect(sanitizeSentryServerTransaction(brute)).toBeNull();
  });
});

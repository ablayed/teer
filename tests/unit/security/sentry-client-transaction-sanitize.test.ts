import {
  sanitizeSentryClientSpan,
  sanitizeSentryClientTransaction,
} from '@/lib/security/sanitize-sentry-client-transaction';
import { describe, expect, it } from 'vitest';

describe('sanitizeSentryClientTransaction', () => {
  it('normalizes shop and order identifiers and keeps only timing fields and Web Vitals', () => {
    const result = sanitizeSentryClientTransaction({
      event_id: 'event-id',
      type: 'transaction',
      transaction: 'pageload /s/shop-secret/commandes/order-secret',
      request: {
        url: 'https://teerafrik.com/s/shop-secret/commandes/order-secret?query=Client%20Inline',
        headers: { cookie: 'session-secret', authorization: 'token-secret' },
      },
      release: '8840e0a',
      environment: 'vercel-production',
      user: { id: 'user-secret' },
      extra: { payload: 'business-payload' },
      tags: { shop_id: 'shop-secret', route: '/raw' },
      measurements: {
        lcp: { value: 2400, unit: 'millisecond' },
        inp: { value: 120, unit: 'millisecond' },
        cls: { value: 0.02, unit: 'none' },
        fcp: { value: 900, unit: 'millisecond' },
        ttfb: { value: 300, unit: 'millisecond' },
        'custom.secret': { value: 1, unit: 'none' },
      },
      spans: [
        {
          span_id: 'span-id',
          op: 'http.client',
          description: 'https://db.example/rest/v1/orders?id=order-secret',
          data: { url: 'https://db.example/rest/v1/orders?id=order-secret' },
          start_timestamp: 1,
          timestamp: 2,
        },
        {
          op: 'http.client',
          description: 'must be dropped without timing',
        },
      ],
    });

    expect(result).toMatchObject({
      transaction: 'pageload /s/[shop]/commandes/[id]',
      transaction_info: { source: 'route' },
      release: '8840e0a',
      environment: 'vercel-production',
      tags: { route: '/s/[shop]/commandes/[id]', navigation_type: 'pageload' },
      measurements: {
        lcp: { value: 2400, unit: 'millisecond' },
        inp: { value: 120, unit: 'millisecond' },
        cls: { value: 0.02, unit: 'none' },
        fcp: { value: 900, unit: 'millisecond' },
        ttfb: { value: 300, unit: 'millisecond' },
      },
      spans: [{ span_id: 'span-id', op: 'http.client', start_timestamp: 1, timestamp: 2 }],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /shop-secret|order-secret|Client Inline|session-secret|token-secret|user-secret|business-payload|db\.example|custom\.secret|description|authorization|cookie/,
    );
  });

  it('uses a route template in the request URL without retaining the query string', () => {
    const result = sanitizeSentryClientTransaction({
      transaction: 'navigation',
      request: { url: 'https://teerafrik.com/commandes?vue=a-appeler&q=client-secret' },
      contexts: { trace: { op: 'navigation' } },
    });

    expect(result).toMatchObject({
      transaction: 'navigation /commandes',
      tags: { route: '/commandes', navigation_type: 'navigation' },
    });
    expect(JSON.stringify(result)).not.toContain('client-secret');
  });

  it('drops routes outside the approved measurement scope', () => {
    expect(
      sanitizeSentryClientTransaction({
        transaction: 'pageload /api/shopify/ingest/token-secret?x=private',
        request: { url: 'https://teerafrik.com/api/shopify/ingest/token-secret?x=private' },
      }),
    ).toBeNull();
  });
});

describe('sanitizeSentryClientSpan (spans autonomes : interaction / INP)', () => {
  const SHOP = '54b1f80f-23a9-437b-b88b-3227bbd51c3e';

  it('normalise la route, retire les clés hors liste blanche et la description libre', () => {
    const result = sanitizeSentryClientSpan({
      op: 'ui.interaction.click',
      description: 'button.cta[data-order="CANARI-ELEMENT"]',
      data: {
        'sentry.origin': 'auto.http.browser.inp',
        'sentry.op': 'ui.interaction.click',
        'sentry.exclusive_time': 24,
        release: '9c5646d',
        environment: 'perf-test',
        transaction: `/s/${SHOP}/commandes?q=CANARI-RECHERCHE`,
        'user_agent.original': 'Mozilla/5.0 CANARI-UA',
        'url.full': `https://teerafrik.com/s/${SHOP}/commandes?q=CANARI-RECHERCHE`,
        'http.query': 'q=CANARI-RECHERCHE',
      },
    });

    expect(result.data).toEqual({
      'sentry.origin': 'auto.http.browser.inp',
      'sentry.op': 'ui.interaction.click',
      'sentry.exclusive_time': 24,
      release: '9c5646d',
      environment: 'perf-test',
      transaction: '/s/[shop]/commandes',
    });
    expect(result.description).toBe('ui.interaction.click');
    expect(JSON.stringify(result)).not.toContain('CANARI');
    expect(JSON.stringify(result)).not.toContain(SHOP);
  });

  it('retire la route quand elle n’est pas reconnue, au lieu de la laisser passer brute', () => {
    const result = sanitizeSentryClientSpan({
      op: 'ui.interaction.click',
      data: { transaction: `/s/${SHOP}/clients/secret-id`, 'sentry.op': 'ui.interaction.click' },
    });
    expect(result.data).toEqual({ 'sentry.op': 'ui.interaction.click' });
  });
});

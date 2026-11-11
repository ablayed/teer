import assert from 'node:assert/strict';
import test from 'node:test';

// Run against an authorized, synthetic next start only.
const origin = new URL(process.env.SECURITY_LOCAL_ORIGIN ?? 'http://127.0.0.1:3007');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
for (const encoding of ['identity', 'gzip']) {
  for (const [route, topic] of [
    ['/api/shopify/webhooks', 'orders/create'],
    ['/api/shopify/webhooks', 'customers/redact'],
    ['/api/shopify/ingest/synthetic-invalid-token', 'orders/create'],
  ]) {
    test(`S0 ${route} ${topic} ${encoding}: invalid signature stays empty 401`, async () => {
      const response = await fetch(new URL(route, origin), {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'accept-encoding': encoding,
          'content-type': 'application/json',
          'x-shopify-topic': topic,
          'x-shopify-hmac-sha256': 'invalid',
        },
        body: '{}',
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 401);
      assert.equal(await response.text(), '');
      assert.equal(response.headers.get('x-middleware-set-cookie'), null);
    });
  }
}

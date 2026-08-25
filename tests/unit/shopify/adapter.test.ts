import { createHmac } from 'node:crypto';
import {
  authenticateShopifyWebhook,
  identifyValidatingApps,
  normalizeShopifyBulkOperationFinished,
  normalizeShopifyOrder,
  normalizeShopifyProduct,
  normalizeShopifyRefund,
} from '@/lib/shopify/adapter';
import { describe, expect, it } from 'vitest';

const APP_A = { clientId: 'client-a', clientSecret: 'secret-a' };
const APP_B = { clientId: 'client-b', clientSecret: 'secret-b' };

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

describe('Lot L2 — adaptateur Shopify (pur)', () => {
  describe('identifyValidatingApps', () => {
    it("renvoie exactement l'app dont le secret valide le corps", () => {
      const rawBody = JSON.stringify({ id: 1 });
      const hmac = sign(rawBody, APP_A.clientSecret);
      expect(identifyValidatingApps(rawBody, hmac, [APP_A, APP_B])).toEqual([APP_A]);
    });

    it('renvoie un tableau vide si aucun secret ne valide', () => {
      const rawBody = JSON.stringify({ id: 1 });
      const hmac = sign(rawBody, 'wrong-secret');
      expect(identifyValidatingApps(rawBody, hmac, [APP_A, APP_B])).toEqual([]);
    });

    it('renvoie un tableau vide sans en-tête HMAC', () => {
      expect(identifyValidatingApps('{}', null, [APP_A])).toEqual([]);
    });
  });

  describe('authenticateShopifyWebhook', () => {
    it("authentifie et rend l'app qui a validé (jamais un booléen)", () => {
      const rawBody = JSON.stringify({ id: 42 });
      const hmac = sign(rawBody, APP_B.clientSecret);
      const result = authenticateShopifyWebhook({
        rawBody,
        hmacHeader: hmac,
        externalConnectionId: 'shop-a.myshopify.com',
        apps: [APP_A, APP_B],
        payload: { id: 42 },
      });
      expect(result).toEqual({
        platformAppId: APP_B.clientId,
        externalConnectionId: 'shop-a.myshopify.com',
        payload: { id: 42 },
      });
    });

    it('refuse sans externalConnectionId, même avec un HMAC valide', () => {
      const rawBody = JSON.stringify({ id: 1 });
      const hmac = sign(rawBody, APP_A.clientSecret);
      const result = authenticateShopifyWebhook({
        rawBody,
        hmacHeader: hmac,
        externalConnectionId: null,
        apps: [APP_A],
        payload: {},
      });
      expect(result).toBeNull();
    });

    it("refuse quand plus d'une app valide le même corps (collision de secrets)", () => {
      const rawBody = JSON.stringify({ id: 1 });
      const sameSecretApp = { clientId: 'client-c', clientSecret: APP_A.clientSecret };
      const hmac = sign(rawBody, APP_A.clientSecret);
      const result = authenticateShopifyWebhook({
        rawBody,
        hmacHeader: hmac,
        externalConnectionId: 'shop.myshopify.com',
        apps: [APP_A, sameSecretApp],
        payload: {},
      });
      expect(result).toBeNull();
    });
  });

  describe('normalisation', () => {
    it('normalizeShopifyOrder produit une enveloppe order', () => {
      expect(normalizeShopifyOrder({ id: '123' })).toEqual({
        kind: 'order',
        externalOrderId: '123',
        raw: { id: '123' },
      });
    });

    it('normalizeShopifyProduct produit une enveloppe product', () => {
      expect(normalizeShopifyProduct({ id: '456' })).toEqual({
        kind: 'product',
        externalProductId: '456',
        raw: { id: '456' },
      });
    });

    it('normalizeShopifyRefund produit une enveloppe refund rattachée à une commande', () => {
      expect(normalizeShopifyRefund({ orderId: '789' })).toEqual({
        kind: 'refund',
        externalOrderId: '789',
        raw: { orderId: '789' },
      });
    });

    it("normalizeShopifyRefund renvoie null sans orderId (jamais d'enveloppe orpheline)", () => {
      expect(normalizeShopifyRefund({ orderId: null })).toBeNull();
    });

    it('normalizeShopifyBulkOperationFinished produit une enveloppe sans ressource propre', () => {
      expect(normalizeShopifyBulkOperationFinished({ any: 'thing' })).toEqual({
        kind: 'bulk_operation_finished',
        raw: { any: 'thing' },
      });
    });
  });
});

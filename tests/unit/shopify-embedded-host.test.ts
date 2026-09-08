import { buildShopifyEmbeddedAppUrl, decodeShopifyEmbeddedHost } from '@/lib/shopify/embedded-host';
import { describe, expect, it } from 'vitest';

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

describe('décodage du host App Bridge et destination canonique', () => {
  it('décode la forme moderne admin.shopify.com/store/{shop}', () => {
    const host = base64url('admin.shopify.com/store/acme-shop');

    expect(decodeShopifyEmbeddedHost(host)).toBe('admin.shopify.com/store/acme-shop');
  });

  it('décode la forme legacy {shop}.myshopify.com/admin', () => {
    const host = base64url('acme-shop.myshopify.com/admin');

    expect(decodeShopifyEmbeddedHost(host)).toBe('acme-shop.myshopify.com/admin');
  });

  it('refuse un host décodé qui ne correspond à aucune des deux formes', () => {
    const host = base64url('evil.example.com/phishing');

    expect(decodeShopifyEmbeddedHost(host)).toBeNull();
  });

  it('refuse un host non base64url ou vide', () => {
    expect(decodeShopifyEmbeddedHost('not base64!')).toBeNull();
    expect(decodeShopifyEmbeddedHost('')).toBeNull();
  });

  it('construit la destination canonique sans handle d’app, à partir du seul client_id', () => {
    const host = base64url('admin.shopify.com/store/acme-shop');

    expect(buildShopifyEmbeddedAppUrl(host, 'client-sentinel')).toBe(
      'https://admin.shopify.com/store/acme-shop/apps/client-sentinel',
    );
  });

  it('renvoie null sans destination devinée quand host est invalide', () => {
    expect(buildShopifyEmbeddedAppUrl('not base64!', 'client-sentinel')).toBeNull();
  });
});

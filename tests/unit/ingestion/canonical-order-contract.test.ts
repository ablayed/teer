import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type {
  PersistableCanonicalOrder,
  ResolvedConnectionContext,
  ResolvedShopContext,
} from '@/lib/ingestion/canonical';
import { describe, expect, expectTypeOf, it } from 'vitest';

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? productionFiles(path) : entry.isFile() ? [path] : [];
  });
}

function acceptShopContext(_context: ResolvedShopContext) {}
function acceptConnectionContext(_context: ResolvedConnectionContext) {}

describe('contrat canonique de commande', () => {
  it('porte les données métier requises sans exposer raw au moteur', () => {
    const order = {
      kind: 'order',
      externalOrderId: 'csv-42',
      raw: { ignored: true },
      data: {
        payloadVersion: 'csv-v1',
        eventAt: '2026-09-10T00:00:00.000Z',
        createdAt: null,
        updatedAt: null,
        orderNumber: '42',
        totalAmount: 1200,
        currency: null,
        customer: { fullName: 'Client', phone: '+221771234567', address: null },
        shippingAddress: null,
        lines: [{ title: 'Article', sku: null, quantity: 1, unitAmount: 1200, productId: null }],
      },
    } satisfies PersistableCanonicalOrder;
    expect(order.data.payloadVersion).toBe('csv-v1');
    expectTypeOf(order).toMatchTypeOf<PersistableCanonicalOrder>();
  });

  it('refuse à la compilation les contextes bruts', () => {
    const raw = { merchantAccountId: 'merchant', shopId: 'shop' };
    // @ts-expect-error Le brand nominal interdit un contexte boutique forgé.
    acceptShopContext(raw);
    // @ts-expect-error Le brand nominal interdit un contexte connexion forgé.
    acceptConnectionContext(raw);
    expect(true).toBe(true);
  });

  it('n’autorise que les producteurs nommés des contextes nominaux', () => {
    const root = process.cwd();
    const casts = productionFiles(resolve(root, 'lib'))
      .flatMap((file) => {
        const content = readFileSync(file, 'utf8');
        const relativePath = relative(root, file).replaceAll('\\', '/');
        return [
          ...Array.from(
            content.matchAll(/as unknown as ResolvedConnectionContext/g),
            () => relativePath,
          ),
          ...Array.from(content.matchAll(/as unknown as ResolvedShopContext/g), () => relativePath),
        ];
      })
      .sort();

    expect(casts).toEqual([
      'lib/ingestion/resolve-connection.ts',
      'lib/ingestion/resolve-connection.ts',
      'lib/ingestion/resolve-connection.ts',
      'lib/ingestion/resolve-shop-context.ts',
    ]);
  });
});

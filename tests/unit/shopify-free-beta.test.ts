import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf8');

describe('Shopify free beta surface', () => {
  it('does not expose an external payment path', () => {
    const pricing = read('components/marketing/pricing.tsx');
    const marketing = read('app/(marketing)/page.tsx');
    const shopifyEntry = read('app/(app)/boutiques/page.tsx');
    const forbiddenPaymentTerms = /Wave|Orange\s+Money|PayDunya|Bictorys|checkout/i;

    expect(`${pricing}\n${marketing}\n${shopifyEntry}`).not.toMatch(forbiddenPaymentTerms);
  });

  it('marks the public offer free and paid features unavailable', () => {
    const messages = JSON.parse(read('messages/fr.json')) as {
      marketing?: { pricing?: { free_price?: string; pro_price?: string } };
    };
    const pricing = messages.marketing?.pricing;

    expect(pricing?.free_price).toBe('0');
    expect(pricing?.pro_price).toBe('Bientôt');
  });
});

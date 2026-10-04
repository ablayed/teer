// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C6 — lecture de `X-Shopify-Triggered-At` (H1) et marge (G9).
//
// Couche : unitaire, fonctions pures. L'effet de chaque cas sur la boutique et sur l'attente est
// prouvé contre PostgreSQL dans tests/rls/shopify-webhooks-1b-uninstall-order.integration.test.ts.
import {
  SHOPIFY_UNINSTALL_ORDER_MARGIN_SECONDS,
  isIsoTimestamp,
  parseShopifyTriggeredAt,
} from '@/lib/shopify/uninstall-order';
import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-10-04T12:00:00.000Z');

describe('marge de comparaison (G9)', () => {
  it('vaut 10 secondes — valeur provisoire, couvrant le seul écart d’horloge', () => {
    expect(SHOPIFY_UNINSTALL_ORDER_MARGIN_SECONDS).toBe(10);
  });
});

describe('parseShopifyTriggeredAt', () => {
  it('rend la chaîne REÇUE pour un horodatage ISO passé, sans la réécrire', () => {
    // Précision à la nanoseconde, telle que Shopify l'envoie : conservée pour la base.
    const raw = '2026-10-04T11:59:20.877041743Z';
    expect(parseShopifyTriggeredAt(raw, NOW)).toEqual({ value: raw, anomaly: null });
    expect(parseShopifyTriggeredAt('2026-10-04T13:59:20+02:00', NOW)).toEqual({
      value: '2026-10-04T13:59:20+02:00',
      anomaly: null,
    });
  });

  it('absent ou vide → NULL, anomalie « absent »', () => {
    for (const raw of [null, undefined, '', '   ']) {
      expect(parseShopifyTriggeredAt(raw, NOW)).toEqual({ value: null, anomaly: 'absent' });
    }
  });

  it('illisible, ou d’une forme lâche que Date.parse accepterait → NULL, anomalie « unreadable »', () => {
    for (const raw of [
      'pas-une-date',
      'Oct 3 2026',
      '2026',
      '2026-10-04',
      '2026-10-04T11:59:20',
      '1759579160',
      '2026-13-45T99:99:99Z',
    ]) {
      expect(parseShopifyTriggeredAt(raw, NOW), raw).toEqual({
        value: null,
        anomaly: 'unreadable',
      });
    }
  });

  it('postérieur à maintenant + la marge → NULL, anomalie « future »', () => {
    const justBeyond = new Date(NOW + 10_001).toISOString();
    expect(parseShopifyTriggeredAt(justBeyond, NOW)).toEqual({ value: null, anomaly: 'future' });
  });

  it('dans la marge au-delà de maintenant (écart d’horloge toléré) → accepté', () => {
    const withinMargin = new Date(NOW + 9_000).toISOString();
    expect(parseShopifyTriggeredAt(withinMargin, NOW)).toEqual({
      value: withinMargin,
      anomaly: null,
    });
  });

  it('la marge est un PARAMÈTRE : elle déplace la frontière du futur', () => {
    const ahead = new Date(NOW + 60_000).toISOString();
    expect(parseShopifyTriggeredAt(ahead, NOW, 10).anomaly).toBe('future');
    expect(parseShopifyTriggeredAt(ahead, NOW, 120).anomaly).toBeNull();
  });
});

describe('isIsoTimestamp — ce qui peut être écrit dans une colonne timestamptz', () => {
  it('accepte un horodatage ISO complet, quel que soit son sens par rapport à maintenant', () => {
    expect(isIsoTimestamp('2026-10-04T11:59:20Z')).toBe(true);
    expect(isIsoTimestamp('2099-01-01T00:00:00.123456789Z')).toBe(true);
  });

  it('refuse l’absence et toute valeur illisible', () => {
    for (const raw of [null, undefined, '', 'pas-une-date', 'Oct 3 2026']) {
      expect(isIsoTimestamp(raw)).toBe(false);
    }
  });
});

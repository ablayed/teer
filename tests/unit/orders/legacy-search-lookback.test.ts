import { LEGACY_SEARCH_LOOKBACK_MONTHS, legacySearchLookbackIso } from '@/lib/orders/search';
import { describe, expect, it } from 'vitest';

// Fix de triage (freeze /commandes à la recherche, cf. CLAUDE.md) : le chemin de recherche
// legacy borne désormais son scan à 12 mois glissants. Ce test verrouille le calcul de la
// borne elle-même (unité), indépendamment du reste de listOrdersForPageData qui n'est pas
// unit-testable directement (import de lib/env.ts, cf. gotcha CLAUDE.md).
describe('legacySearchLookbackIso', () => {
  it('recule de exactement LEGACY_SEARCH_LOOKBACK_MONTHS mois par rapport à une date de référence', () => {
    const reference = new Date('2026-07-14T12:00:00.000Z');

    const result = legacySearchLookbackIso(reference);

    expect(result).toBe('2025-07-14T12:00:00.000Z');
  });

  it('utilise la valeur documentée de 12 mois', () => {
    expect(LEGACY_SEARCH_LOOKBACK_MONTHS).toBe(12);
  });

  it("n'altère pas la date de référence passée en paramètre", () => {
    const reference = new Date('2026-07-14T12:00:00.000Z');
    const referenceCopy = new Date(reference);

    legacySearchLookbackIso(reference);

    expect(reference.toISOString()).toBe(referenceCopy.toISOString());
  });
});

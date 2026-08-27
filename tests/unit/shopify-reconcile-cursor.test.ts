/**
 * Phase F — Lot R1, étape 2 : `computeNextReconcileCursor` (lib/shopify/reconcile.ts), la fonction
 * pure qui décide de combien le curseur `shop.last_reconciled_at` avance après un passage du cron
 * de réconciliation. Une ligne de test par ligne du tableau §3.1 du lot.
 *
 * Mutation-testée manuellement (rapportée dans le rapport de fin de lot) : en remplaçant le corps
 * par `return runStartedAt` inconditionnel (l'ancien comportement, avant ce lot), les tests
 * "n'a pas dépassé cette commande" / "plusieurs échecs dispersés" / "échec sans horodatage
 * exploitable" passent au rouge.
 */

import { computeNextReconcileCursor } from '@/lib/shopify/reconcile';
import { describe, expect, it } from 'vitest';

describe('computeNextReconcileCursor', () => {
  const runStartedAt = '2026-08-27T02:00:00.000Z';
  const previousCursor = '2026-08-26T02:00:00.000Z';

  it('toutes les commandes persistées → avance jusqu’à runStartedAt', () => {
    const cursor = computeNextReconcileCursor(previousCursor, runStartedAt, [
      { shopifyOrderId: 'a', updatedAt: '2026-08-26T10:00:00Z', ok: true },
      { shopifyOrderId: 'b', updatedAt: '2026-08-26T14:00:00Z', ok: true },
    ]);
    expect(cursor).toBe(runStartedAt);
  });

  it('une commande en échec au milieu du lot → ne dépasse pas cette commande', () => {
    const cursor = computeNextReconcileCursor(previousCursor, runStartedAt, [
      { shopifyOrderId: 'a', updatedAt: '2026-08-26T10:00:00Z', ok: true },
      { shopifyOrderId: 'b', updatedAt: '2026-08-26T14:00:00Z', ok: false },
      { shopifyOrderId: 'c', updatedAt: '2026-08-26T18:00:00Z', ok: true },
    ]);
    expect(cursor).toBe('2026-08-26T14:00:00.000Z');
  });

  it('plusieurs échecs dispersés → ne dépasse pas le plus ancien', () => {
    const cursor = computeNextReconcileCursor(previousCursor, runStartedAt, [
      { shopifyOrderId: 'a', updatedAt: '2026-08-26T09:00:00Z', ok: true },
      { shopifyOrderId: 'b', updatedAt: '2026-08-26T11:00:00Z', ok: false },
      { shopifyOrderId: 'c', updatedAt: '2026-08-26T15:00:00Z', ok: true },
      { shopifyOrderId: 'd', updatedAt: '2026-08-26T20:00:00Z', ok: false },
    ]);
    expect(cursor).toBe('2026-08-26T11:00:00.000Z');
  });

  it('échec sans updated_at exploitable → le curseur n’avance pas du tout', () => {
    const cursor = computeNextReconcileCursor(previousCursor, runStartedAt, [
      { shopifyOrderId: 'a', updatedAt: '2026-08-26T10:00:00Z', ok: true },
      { shopifyOrderId: 'b', updatedAt: null, ok: false },
    ]);
    expect(cursor).toBe(previousCursor);
  });

  it('aucune commande à traiter (liste vide) → avance jusqu’à runStartedAt', () => {
    const cursor = computeNextReconcileCursor(previousCursor, runStartedAt, []);
    expect(cursor).toBe(runStartedAt);
  });

  it('contrôle positif : un seul échec isolé bloque exactement à son horodatage, ni avant ni après', () => {
    const cursor = computeNextReconcileCursor(previousCursor, runStartedAt, [
      { shopifyOrderId: 'a', updatedAt: '2026-08-26T12:34:56Z', ok: false },
    ]);
    expect(cursor).toBe('2026-08-26T12:34:56.000Z');
    expect(cursor).not.toBe(runStartedAt);
    expect(cursor).not.toBe(previousCursor);
  });
});

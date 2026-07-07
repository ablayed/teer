import { computeDriverStockSetPlan } from '@/lib/drivers/driver-stock-set';
import { describe, expect, it } from 'vitest';

describe('computeDriverStockSetPlan', () => {
  it('delta === 0 → noop, aucune écriture', () => {
    const plan = computeDriverStockSetPlan({ currentQty: 5, newQty: 5, centralAvailable: 100 });
    expect(plan).toEqual({ kind: 'noop' });
  });

  it('augmentation couverte par le stock central → apply, delta positif', () => {
    const plan = computeDriverStockSetPlan({ currentQty: 5, newQty: 12, centralAvailable: 20 });
    expect(plan).toEqual({ kind: 'apply', delta: 7 });
  });

  it('augmentation exactement égale au stock central disponible → apply (limite incluse)', () => {
    const plan = computeDriverStockSetPlan({ currentQty: 5, newQty: 12, centralAvailable: 7 });
    expect(plan).toEqual({ kind: 'apply', delta: 7 });
  });

  it('augmentation au-delà du stock central → bloqué avec le montant manquant exact', () => {
    const plan = computeDriverStockSetPlan({ currentQty: 5, newQty: 12, centralAvailable: 4 });
    expect(plan).toEqual({ kind: 'blocked', reason: 'central', missingQty: 3 });
  });

  it('diminution dans la limite du physique → apply, delta négatif', () => {
    const plan = computeDriverStockSetPlan({ currentQty: 10, newQty: 4, centralAvailable: 0 });
    expect(plan).toEqual({ kind: 'apply', delta: -6 });
  });

  it('diminution jusqu’à zéro exactement → apply (limite incluse, pas un blocage)', () => {
    const plan = computeDriverStockSetPlan({ currentQty: 10, newQty: 0, centralAvailable: 0 });
    expect(plan).toEqual({ kind: 'apply', delta: -10 });
  });

  // Le stock physique ne peut jamais être négatif : un newQty < 0 revient à
  // demander un retrait au-delà de 0, quel que soit currentQty (l'algèbre
  // annule currentQty : excessQty = -newQty dans tous les cas). C'est la seule
  // façon d'atteindre le blocage "physique" en saisie valeur absolue — le
  // schéma Zod de l'action n'a volontairement PAS de .min(0) pour que ce cas
  // atteigne cette fonction plutôt qu'une erreur de validation générique.
  it('newQty négatif → bloqué "physical", montant en trop = -newQty quel que soit currentQty', () => {
    const smallStock = computeDriverStockSetPlan({
      currentQty: 3,
      newQty: -2,
      centralAvailable: 0,
    });
    expect(smallStock).toEqual({
      kind: 'blocked',
      reason: 'physical',
      currentQty: 3,
      excessQty: 2,
    });

    const largeStock = computeDriverStockSetPlan({
      currentQty: 100,
      newQty: -2,
      centralAvailable: 0,
    });
    expect(largeStock).toEqual({
      kind: 'blocked',
      reason: 'physical',
      currentQty: 100,
      excessQty: 2,
    });
  });

  it('livreur déjà à zéro, augmentation demandée → apply si le central couvre', () => {
    const plan = computeDriverStockSetPlan({ currentQty: 0, newQty: 5, centralAvailable: 5 });
    expect(plan).toEqual({ kind: 'apply', delta: 5 });
  });
});

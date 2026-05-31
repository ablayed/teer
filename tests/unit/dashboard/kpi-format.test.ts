import { calculateTauxConfirmation, calculateTauxLivraison } from '@/lib/dashboard/kpi-format';
import { formatFCFA } from '@/lib/format/fcfa';
import { describe, expect, it } from 'vitest';

describe('dashboard KPI formatting', () => {
  it('formate 0 F CFA', () => {
    expect(formatFCFA(0).replace(/[\u202F\u00A0]/g, ' ')).toBe('0 F CFA');
  });

  it('formate 182500 F CFA', () => {
    expect(formatFCFA(182500).replace(/[\u202F\u00A0]/g, ' ')).toBe('182 500 F CFA');
  });

  it('retourne 0 pour le taux de confirmation sans commandes cr\u00e9\u00e9es', () => {
    expect(calculateTauxConfirmation(0, 0)).toBe(0);
  });

  it('retourne 0 pour le taux de livraison sans base livrable', () => {
    expect(calculateTauxLivraison({ deliveredCount: 0, postConfirmationFailedCount: 0 })).toBe(0);
  });
});

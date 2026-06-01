import { formatDashboardMoney } from '@/components/dashboard/dashboard-format';
import { describe, expect, it } from 'vitest';

describe('dashboard formatters', () => {
  it('formate XOF sans decimales avec groupement francais', () => {
    expect(formatDashboardMoney(1_500_000, 'XOF')).toMatch(
      /1[\s\u202F]500[\s\u202F]000[\s\u202F]F[\s\u202F]CFA/,
    );
  });

  it('formate USD avec les decimales CLDR et le code devise', () => {
    expect(formatDashboardMoney(1_500_000, 'USD')).toMatch(
      /1[\s\u202F]500[\s\u202F]000,00[\s\u00A0]\$US/,
    );
  });
});

import {
  type MerchantFeeSettings,
  digitalSettlementFeesMinor,
  estimatedMarginMinor,
  providerFeeMinor,
  transferTaxMinor,
} from '@/lib/finance/fees';
import { describe, expect, it } from 'vitest';

const settings: MerchantFeeSettings = {
  cogs_known: false,
  default_delivery_cost_minor: 1_500,
  free_money_fee_bps: 150,
  merchant_levy_bps: 50,
  orange_money_fee_bps: 125,
  transfer_tax_bps: 50,
  transfer_tax_cap_minor: 2_000,
  wave_fee_bps: 100,
};

describe('finance fees', () => {
  it('ne facture aucun frais fournisseur sur les espèces', () => {
    expect(providerFeeMinor(10_000, 'ESPECES', settings)).toBe(0);
  });

  it('calcule les frais Wave à 1%', () => {
    expect(providerFeeMinor(10_000, 'WAVE', settings)).toBe(100);
  });

  it('calcule les frais Orange Money et Free Money selon les bps configurés', () => {
    expect(providerFeeMinor(20_000, 'ORANGE_MONEY', settings)).toBe(250);
    expect(providerFeeMinor(20_000, 'FREE_MONEY', settings)).toBe(300);
  });

  it('plafonne la TTA à 2 000 F CFA', () => {
    expect(transferTaxMinor(100_000, settings)).toBe(500);
    expect(transferTaxMinor(1_000_000, settings)).toBe(2_000);
  });

  it('additionne les frais digitaux sans frais sur espèces', () => {
    expect(
      digitalSettlementFeesMinor({ amountReceivedMinor: 10_000, method: 'ESPECES' }, settings),
    ).toBe(0);
    expect(
      digitalSettlementFeesMinor({ amountReceivedMinor: 10_000, method: 'WAVE' }, settings),
    ).toBe(200);
  });

  it('calcule une marge estimée avec COGS à 0 quand cogs_known=false', () => {
    expect(
      estimatedMarginMinor({
        caLivreMinor: 100_000,
        deliveredOrdersCount: 3,
        settlements: [
          { amountReceivedMinor: 10_000, method: 'WAVE' },
          { amountReceivedMinor: 20_000, method: 'ESPECES' },
        ],
        settings,
      }),
    ).toBe(95_300);
  });

  it('arrondit les frais en francs entiers', () => {
    expect(providerFeeMinor(333, 'WAVE', settings)).toBe(3);
    expect(providerFeeMinor(350, 'WAVE', settings)).toBe(4);
  });
});

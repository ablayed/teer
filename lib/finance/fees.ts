import type { SettlementMethod } from '@/lib/finance/cash';

export type MerchantFeeSettings = {
  cogs_known: boolean;
  default_delivery_cost_minor: number;
  free_money_fee_bps: number;
  merchant_levy_bps: number;
  orange_money_fee_bps: number;
  transfer_tax_bps: number;
  transfer_tax_cap_minor: number;
  wave_fee_bps: number;
};

export type SettlementForMargin = {
  amountReceivedMinor: number;
  method: SettlementMethod;
};

export type EstimatedMarginInput = {
  caLivreMinor: number;
  deliveredOrdersCount?: number;
  settlements: SettlementForMargin[];
  settings: MerchantFeeSettings;
};

function assertWholeMinor(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label}: invalid minor amount`);
  }
}

function assertBps(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`${label}: invalid basis points`);
  }
}

function roundBpsMinor(amountMinor: number, bps: number): number {
  assertWholeMinor(amountMinor, 'amountMinor');
  assertBps(bps, 'bps');

  const rounded = (BigInt(amountMinor) * BigInt(bps) + 5_000n) / 10_000n;
  const asNumber = Number(rounded);

  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError('roundBpsMinor: unsafe result');
  }

  return asNumber;
}

export function providerFeeMinor(
  amountMinor: number,
  method: SettlementMethod,
  settings: MerchantFeeSettings,
): number {
  if (method === 'ESPECES') {
    return 0;
  }

  const bpsByMethod: Record<Exclude<SettlementMethod, 'ESPECES'>, number> = {
    FREE_MONEY: settings.free_money_fee_bps,
    ORANGE_MONEY: settings.orange_money_fee_bps,
    WAVE: settings.wave_fee_bps,
  };

  return roundBpsMinor(amountMinor, bpsByMethod[method]);
}

export function merchantLevyMinor(amountMinor: number, settings: MerchantFeeSettings): number {
  return roundBpsMinor(amountMinor, settings.merchant_levy_bps);
}

export function transferTaxMinor(amountMinor: number, settings: MerchantFeeSettings): number {
  assertWholeMinor(settings.transfer_tax_cap_minor, 'transferTaxCapMinor');

  return Math.min(
    roundBpsMinor(amountMinor, settings.transfer_tax_bps),
    settings.transfer_tax_cap_minor,
  );
}

export function digitalSettlementFeesMinor(
  settlement: SettlementForMargin,
  settings: MerchantFeeSettings,
): number {
  if (settlement.method === 'ESPECES') {
    return 0;
  }

  return (
    providerFeeMinor(settlement.amountReceivedMinor, settlement.method, settings) +
    merchantLevyMinor(settlement.amountReceivedMinor, settings) +
    transferTaxMinor(settlement.amountReceivedMinor, settings)
  );
}

export function estimatedMarginMinor({
  caLivreMinor,
  deliveredOrdersCount = 0,
  settlements,
  settings,
}: EstimatedMarginInput): number {
  assertWholeMinor(caLivreMinor, 'caLivreMinor');

  const deliveryCostsMinor = deliveredOrdersCount * settings.default_delivery_cost_minor;
  const feesMinor = settlements.reduce(
    (total, settlement) => total + digitalSettlementFeesMinor(settlement, settings),
    0,
  );

  return caLivreMinor - deliveryCostsMinor - feesMinor;
}

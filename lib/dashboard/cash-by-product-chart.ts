import type { FinanceRevenueByProductRow } from '@/lib/finance/product-cost';
import { formatFCFACompact } from '@/lib/format/fcfa';

export const CASH_BY_PRODUCT_LIMIT = 7;
export const CASH_BY_PRODUCT_LABEL_MAX_LENGTH = 34;

export type CashByProductChartRow = {
  productId: string;
  revenueMinor: number;
  shortTitle: string;
  title: string;
};

export function truncateCashByProductLabel(
  value: string,
  maxLength = CASH_BY_PRODUCT_LABEL_MAX_LENGTH,
): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}\u2026`;
}

export function formatCashByProductCompactAmount(value: number): string {
  return formatFCFACompact(value).replace(/[\s\u202f]F CFA$/, ' F');
}

export function buildCashByProductChartRows(
  items: FinanceRevenueByProductRow[],
  {
    limit = CASH_BY_PRODUCT_LIMIT,
    maxLabelLength = CASH_BY_PRODUCT_LABEL_MAX_LENGTH,
  }: { limit?: number; maxLabelLength?: number } = {},
): CashByProductChartRow[] {
  const seenLabels = new Map<string, number>();

  return items
    .filter((item) => item.revenueMinor > 0)
    .slice(0, limit)
    .map((item) => {
      const baseLabel = truncateCashByProductLabel(item.title, maxLabelLength);
      const seenCount = seenLabels.get(baseLabel) ?? 0;
      seenLabels.set(baseLabel, seenCount + 1);
      const suffix = seenCount > 0 ? ` ${seenCount + 1}` : '';
      const shortTitle =
        suffix.length > 0
          ? `${truncateCashByProductLabel(item.title, Math.max(4, maxLabelLength - suffix.length))}${suffix}`
          : baseLabel;

      return {
        productId: item.productId,
        revenueMinor: item.revenueMinor,
        shortTitle,
        title: item.title,
      };
    });
}

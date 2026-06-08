import { deriveRefundWebhook, isCashLikeRefundGateway } from '@/lib/shopify/refunds';
import { describe, expect, it } from 'vitest';

describe('deriveRefundWebhook', () => {
  it('met a jour le miroir financier seulement si un refund non-COD a reussi', () => {
    const result = deriveRefundWebhook({
      order_id: 123456789,
      transactions: [
        {
          amount: '15000.00',
          gateway: 'wave',
          kind: 'refund',
          status: 'success',
        },
      ],
    });

    expect(result.orderId).toBe('123456789');
    expect(result.nonCashRefundedMinor).toBe(15000);
    expect(result.cashStillHeldByTeer).toBe(false);
    expect(result.shouldUpdateFinancialStatus).toBe(true);
    expect(result.successfulRefundCount).toBe(1);
  });

  it('n interprete pas un refund COD comme cash sorti de Teer', () => {
    const result = deriveRefundWebhook({
      order_id: 987654321,
      transactions: [
        {
          amount: '12000',
          gateway: 'manual',
          kind: 'refund',
          status: 'success',
        },
      ],
    });

    expect(result.nonCashRefundedMinor).toBe(0);
    expect(result.cashStillHeldByTeer).toBe(true);
    expect(result.shouldUpdateFinancialStatus).toBe(false);
    expect(result.successfulRefundCount).toBe(1);
  });

  it('ignore un refund sans transaction succes', () => {
    const result = deriveRefundWebhook({
      order_id: 123,
      transactions: [
        {
          amount: '5000',
          gateway: 'wave',
          kind: 'refund',
          status: 'pending',
        },
      ],
    });

    expect(result.nonCashRefundedMinor).toBe(0);
    expect(result.cashStillHeldByTeer).toBe(false);
    expect(result.shouldUpdateFinancialStatus).toBe(false);
    expect(result.successfulRefundCount).toBe(0);
  });
});

describe('isCashLikeRefundGateway', () => {
  it('reconnait les gateways cash-like', () => {
    expect(isCashLikeRefundGateway('manual')).toBe(true);
    expect(isCashLikeRefundGateway('cash on delivery')).toBe(true);
    expect(isCashLikeRefundGateway('wave')).toBe(false);
  });
});

import type { Json } from '@/lib/supabase/database.types';

type RefundDerivation = {
  cashStillHeldByTeer: boolean;
  nonCashRefundedMinor: number;
  orderId: string | null;
  // Identifiant PROPRE du remboursement (champ racine `id` de l'objet Refund Shopify,
  // shopify.dev/docs/api/admin-rest/latest/resources/refund) — distinct de `orderId`, stable
  // entre deux livraisons du même événement. Base de l'idempotence métier (lot dédié) :
  // jamais confondu avec un delivery_id de webhook, qui diffère à chaque livraison même pour
  // le même remboursement.
  externalRefundId: string | null;
  shouldUpdateFinancialStatus: boolean;
  successfulRefundCount: number;
  transactionSummary: Json;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function amountToMinor(value: string | null): number {
  if (!value) {
    return 0;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function isSuccessfulRefundTransaction(transaction: Record<string, unknown>): boolean {
  const kind = stringField(transaction, 'kind')?.toLowerCase();
  const status = stringField(transaction, 'status')?.toLowerCase();

  return kind === 'refund' && status === 'success';
}

export function isCashLikeRefundGateway(gateway: string | null): boolean {
  if (!gateway) {
    return true;
  }

  const normalized = gateway.toLowerCase();
  return (
    normalized.includes('cash') ||
    normalized.includes('cod') ||
    normalized.includes('manual') ||
    normalized.includes('especes')
  );
}

export function deriveRefundWebhook(payload: unknown): RefundDerivation {
  const record = isRecord(payload) ? payload : null;
  const orderId = record ? stringField(record, 'order_id') : null;
  const externalRefundId = record ? stringField(record, 'id') : null;
  const transactions = record && Array.isArray(record.transactions) ? record.transactions : [];

  let successfulRefundCount = 0;
  let nonCashRefundedMinor = 0;
  let cashStillHeldByTeer = false;

  const transactionSummary = transactions.filter(isRecord).map((transaction) => {
    const gateway = stringField(transaction, 'gateway');
    const amountMinor = amountToMinor(stringField(transaction, 'amount'));
    const successful = isSuccessfulRefundTransaction(transaction);
    const cashLike = isCashLikeRefundGateway(gateway);

    if (successful) {
      successfulRefundCount += 1;

      if (cashLike) {
        cashStillHeldByTeer = true;
      } else {
        nonCashRefundedMinor += amountMinor;
      }
    }

    return {
      amount_minor: amountMinor,
      cash_like: cashLike,
      gateway,
      kind: stringField(transaction, 'kind'),
      status: stringField(transaction, 'status'),
      successful,
    };
  });

  return {
    cashStillHeldByTeer,
    nonCashRefundedMinor,
    orderId,
    externalRefundId,
    shouldUpdateFinancialStatus: nonCashRefundedMinor > 0,
    successfulRefundCount,
    transactionSummary,
  };
}

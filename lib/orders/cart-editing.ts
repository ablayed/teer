export type CartEditableOrderState = {
  cashState: string | null;
  deliveryState: string | null;
};

export type CartPriceLine = {
  quantity: number;
  unitPrice: number;
};

export type CartEditingMode = 'full' | 'reduction';

const collectedCashStates = new Set(['collected', 'remitted', 'discrepancy']);
const terminalDeliveryStates = new Set(['delivered', 'failed', 'returned']);

export function getOrderCartEditingMode({
  cashState,
  deliveryState,
}: CartEditableOrderState): CartEditingMode | null {
  if (deliveryState === 'unassigned') return cashState === 'not_due' ? 'full' : null;
  if (!deliveryState || terminalDeliveryStates.has(deliveryState)) return null;
  if (!cashState || collectedCashStates.has(cashState)) return null;
  return 'reduction';
}

export function canEditOrderCart({ cashState, deliveryState }: CartEditableOrderState): boolean {
  return getOrderCartEditingMode({ cashState, deliveryState }) !== null;
}

export function calculateCartTotal(lines: readonly CartPriceLine[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}

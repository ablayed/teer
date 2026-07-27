export type CartEditableOrderState = {
  cashState: string | null;
  deliveryState: string | null;
};

export type CartPriceLine = {
  quantity: number;
  unitPrice: number;
};

export type CartEditingMode = 'full' | 'reduction';

export function getOrderCartEditingMode({
  cashState,
  deliveryState,
}: CartEditableOrderState): CartEditingMode | null {
  if (cashState !== 'not_due') return null;
  return deliveryState === 'unassigned' ? 'full' : 'reduction';
}

export function canEditOrderCart({ cashState, deliveryState }: CartEditableOrderState): boolean {
  return getOrderCartEditingMode({ cashState, deliveryState }) !== null;
}

export function calculateCartTotal(lines: readonly CartPriceLine[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}

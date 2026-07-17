export type CartEditableOrderState = {
  cashState: string | null;
  deliveryState: string | null;
};

export type CartPriceLine = {
  quantity: number;
  unitPrice: number;
};

export function canEditOrderCart({ cashState, deliveryState }: CartEditableOrderState): boolean {
  return deliveryState === 'unassigned' && cashState === 'not_due';
}

export function calculateCartTotal(lines: readonly CartPriceLine[]): number {
  return lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0);
}

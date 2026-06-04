import type {
  DeliveryStateDimension,
  TransitionAction,
} from '@/lib/domain/order-transition-actions';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type AdminClient = SupabaseClient<Database>;

export type StockMovementType =
  | 'courier_return'
  | 'dispatch'
  | 'manual_adjustment'
  | 'purchase_in'
  | 'release'
  | 'reserve'
  | 'sold';

// Returns null when the action produces no stock movement.
export function getMovementTypeForAction(
  action: TransitionAction,
  currentDeliveryState: DeliveryStateDimension,
): StockMovementType | null {
  switch (action) {
    case 'confirmer':
      return 'reserve';
    case 'assigner':
      return 'dispatch';
    case 'livrer':
      return 'sold';
    case 'annuler':
    case 'refuser':
      // Before dispatch (stock still in warehouse) → release soft reservation.
      // After dispatch (stock with courier) → no auto-restore; courier_return is posted manually.
      return currentDeliveryState === 'unassigned' || currentDeliveryState === 'scheduled'
        ? 'release'
        : null;
    default:
      return null;
  }
}

type StockPosition = { qty_on_hand: number; qty_reserved: number; unit_cost: number };

async function readOrInitStock(admin: AdminClient, productId: string): Promise<StockPosition> {
  const { data } = await admin
    .from('product_stock')
    .select('qty_on_hand, qty_reserved, unit_cost')
    .eq('product_id', productId)
    .maybeSingle();
  return data ?? { qty_on_hand: 0, qty_reserved: 0, unit_cost: 0 };
}

async function upsertStock(
  admin: AdminClient,
  productId: string,
  merchantAccountId: string,
  patch: StockPosition,
): Promise<void> {
  await admin.from('product_stock').upsert(
    {
      product_id: productId,
      merchant_account_id: merchantAccountId,
      qty_on_hand: Math.max(0, patch.qty_on_hand),
      qty_reserved: Math.max(0, patch.qty_reserved),
      unit_cost: patch.unit_cost,
    },
    { onConflict: 'product_id' },
  );
}

// qty is the signed delta stored in stock_movement (positive = inflow, negative = outflow).
function signedQty(movementType: StockMovementType, lineQty: number): number {
  switch (movementType) {
    case 'release':
    case 'dispatch':
      return -lineQty;
    default:
      return lineQty;
  }
}

function applyMovement(
  current: StockPosition,
  movementType: StockMovementType,
  signed: number,
  unitCost: number | null,
): StockPosition {
  let { qty_on_hand, qty_reserved, unit_cost } = current;

  switch (movementType) {
    case 'reserve':
      qty_reserved = Math.max(0, qty_reserved + signed);
      break;
    case 'release':
      qty_reserved = Math.max(0, qty_reserved + signed);
      break;
    case 'dispatch':
      qty_on_hand = Math.max(0, qty_on_hand + signed);
      qty_reserved = Math.max(0, qty_reserved + signed);
      break;
    case 'sold':
      // COGS snapshot only — no position change.
      break;
    case 'purchase_in': {
      const newTotal = qty_on_hand + signed;
      if (unitCost !== null && newTotal > 0) {
        unit_cost = Math.floor((qty_on_hand * unit_cost + signed * unitCost) / newTotal);
      }
      qty_on_hand = newTotal;
      break;
    }
    case 'courier_return':
      qty_on_hand = qty_on_hand + signed;
      break;
    case 'manual_adjustment':
      qty_on_hand = Math.max(0, qty_on_hand + signed);
      break;
  }

  return { qty_on_hand, qty_reserved, unit_cost };
}

type MovementInput = {
  actorUserId: string;
  idempotencyKey: string;
  merchantAccountId: string;
  movementType: StockMovementType;
  orderId: string | null;
  productId: string;
  qty: number;
  reason?: string | null;
  transitionId: string | null;
  unitCost?: number | null;
};

// Returns true when the movement was newly inserted (not a duplicate).
async function insertMovement(admin: AdminClient, input: MovementInput): Promise<boolean> {
  const { data } = await admin
    .from('stock_movement')
    .upsert(
      {
        merchant_account_id: input.merchantAccountId,
        product_id: input.productId,
        movement_type: input.movementType,
        qty: input.qty,
        unit_cost: input.unitCost ?? null,
        reason: input.reason ?? null,
        order_id: input.orderId ?? null,
        transition_id: input.transitionId ?? null,
        idempotency_key: input.idempotencyKey,
        created_by: input.actorUserId,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle();
  return data !== null;
}

// Applies stock movements for a transition. Called after performTransition succeeds.
// Never throws — stock is a side-effect, never a precondition for the transition.
export async function applyTransitionStockMovements(
  admin: AdminClient,
  supabase: SupabaseClient<Database>,
  {
    action,
    actorUserId,
    currentDeliveryState,
    merchantAccountId,
    orderId,
    transitionId,
  }: {
    action: TransitionAction;
    actorUserId: string;
    currentDeliveryState: DeliveryStateDimension;
    merchantAccountId: string;
    orderId: string;
    transitionId: string | null;
  },
): Promise<void> {
  const movementType = getMovementTypeForAction(action, currentDeliveryState);
  if (!movementType) return;

  const { data: lines } = await supabase
    .from('order_line')
    .select('product_id, qty')
    .eq('order_id', orderId)
    .eq('match_status', 'matched');

  if (!lines || lines.length === 0) return;

  const needsCumpSnapshot = movementType === 'dispatch' || movementType === 'sold';

  for (const line of lines) {
    if (!line.product_id) continue;

    let unitCostSnapshot: number | null = null;
    if (needsCumpSnapshot) {
      const { data: stock } = await admin
        .from('product_stock')
        .select('unit_cost')
        .eq('product_id', line.product_id)
        .maybeSingle();
      unitCostSnapshot = stock?.unit_cost ?? 0;
    }

    const signed = signedQty(movementType, line.qty);
    const idempotencyKey = `${transitionId ?? orderId}:${line.product_id}:${movementType}`;

    const inserted = await insertMovement(admin, {
      actorUserId,
      idempotencyKey,
      merchantAccountId,
      movementType,
      orderId,
      productId: line.product_id,
      qty: signed,
      transitionId,
      unitCost: unitCostSnapshot,
    });

    if (inserted) {
      const current = await readOrInitStock(admin, line.product_id);
      const next = applyMovement(current, movementType, signed, unitCostSnapshot);
      await upsertStock(admin, line.product_id, merchantAccountId, next);
    }
  }
}

// Applies a single explicit stock movement (purchase-in, adjustment, courier-return).
// Returns the new position or null if duplicate (idempotent by key).
export async function applySingleMovement(
  admin: AdminClient,
  input: MovementInput,
): Promise<StockPosition | null> {
  const signed =
    input.movementType === 'manual_adjustment'
      ? input.qty
      : signedQty(input.movementType, Math.abs(input.qty));

  const inserted = await insertMovement(admin, { ...input, qty: signed });
  if (!inserted) return null;

  const current = await readOrInitStock(admin, input.productId);
  const next = applyMovement(current, input.movementType, signed, input.unitCost ?? null);
  await upsertStock(admin, input.productId, input.merchantAccountId, next);
  return next;
}

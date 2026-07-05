-- 0090 : Lot 2 / PR 1 - movement types for driver availability ledger
--
-- Schema-only migration. The behavior is added in 0091 and the one-time
-- historical cutover backfill is added in 0092.

alter table public.stock_movement
  drop constraint if exists stock_movement_type_check;

alter table public.stock_movement
  add constraint stock_movement_type_check
  check (
    movement_type in (
      'purchase_in',
      'reserve',
      'release',
      'dispatch',
      'sold',
      'courier_return',
      'manual_adjustment',
      'allocate_to_courier',
      'courier_return_lot',
      'advance_commit',
      'reassign_from_driver',
      'reassign_to_driver',
      'order_assignment_commit',
      'order_assignment_release'
    )
  )
  not valid;

alter table public.stock_movement
  validate constraint stock_movement_type_check;

alter table public.stock_movement
  drop constraint if exists stock_movement_lot_requires_driver_check;

alter table public.stock_movement
  add constraint stock_movement_lot_requires_driver_check
  check (
    movement_type not in (
      'allocate_to_courier',
      'courier_return_lot',
      'advance_commit',
      'order_assignment_commit',
      'order_assignment_release'
    )
    or driver_id is not null
  )
  not valid;

alter table public.stock_movement
  validate constraint stock_movement_lot_requires_driver_check;

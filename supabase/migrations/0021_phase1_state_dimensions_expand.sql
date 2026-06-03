alter table public.orders
  add column order_state text,
  add column call_state text,
  add column delivery_state text,
  add column cash_state text,
  add column attempt_count integer default 0,
  add column next_contact_at timestamptz,
  add column scheduled_for timestamptz,
  add column cancel_reason text;

alter table public.orders
  add constraint orders_order_state_check
  check (
    order_state is null
    or order_state in ('open', 'completed', 'cancelled', 'returned')
  ) not valid;

alter table public.orders
  add constraint orders_call_state_check
  check (
    call_state is null
    or call_state in ('to_call', 'callback', 'validated', 'unreachable')
  ) not valid;

alter table public.orders
  add constraint orders_delivery_state_check
  check (
    delivery_state is null
    or delivery_state in (
      'unassigned',
      'scheduled',
      'assigned',
      'out_for_delivery',
      'delivered',
      'failed',
      'returned'
    )
  ) not valid;

alter table public.orders
  add constraint orders_cash_state_check
  check (
    cash_state is null
    or cash_state in ('not_due', 'expected', 'collected', 'remitted', 'discrepancy')
  ) not valid;

alter table public.audit_log
  add column prior_state text,
  add column next_state text,
  add column source text,
  add column reason text;

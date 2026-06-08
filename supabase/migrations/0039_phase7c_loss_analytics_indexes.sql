-- Phase 7c - analytics annulations / retours / refus
-- Indexes only. No schema or RLS changes.

create index if not exists orders_merchant_state_delivery_created_idx
  on public.orders (merchant_account_id, order_state, delivery_state, created_at desc);

create index if not exists orders_merchant_source_created_idx
  on public.orders (merchant_account_id, source, created_at desc);

create index if not exists audit_log_order_transition_timeline_idx
  on public.audit_log (merchant_account_id, created_at desc)
  where action = 'order.transition';

create index if not exists audit_log_order_transition_next_delivery_state_idx
  on public.audit_log ((payload->'nextDimensions'->>'delivery_state'))
  where action = 'order.transition';

create table public.webhook_event (
  id uuid primary key default gen_random_uuid(),
  shopify_webhook_id text not null unique,
  topic text not null,
  shop_domain text,
  received_at timestamptz not null default now(),
  processed boolean not null default false
);

create index webhook_event_received_at_idx on public.webhook_event (received_at);

-- System table for Shopify webhook deduplication.
-- RLS is enabled and forced with no permissive policy: only service-role
-- webhook code can bypass RLS and write/read these events.
alter table public.webhook_event enable row level security;
alter table public.webhook_event force row level security;

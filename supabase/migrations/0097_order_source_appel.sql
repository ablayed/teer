alter table public.orders
  drop constraint orders_source_check;

alter table public.orders
  add constraint orders_source_check
  check (
    source is null
    or source in ('shopify', 'whatsapp', 'manual', 'instagram', 'tiktok', 'facebook', 'appel')
  ) not valid;

alter table public.orders
  validate constraint orders_source_check;

-- S1A: purge Shopify customer fields not required by the COD MVP.
-- This migration is append-only and must be applied through the normal release process.

update public.customer
set
  tags = null,
  accepts_marketing = null,
  shopify_orders_count = null,
  shopify_amount_spent_minor = null,
  first_seen_at = null
where tags is not null
   or accepts_marketing is not null
   or shopify_orders_count is not null
   or shopify_amount_spent_minor is not null
   or first_seen_at is not null;

alter table public.customer
  drop column if exists tags,
  drop column if exists accepts_marketing,
  drop column if exists shopify_orders_count,
  drop column if exists shopify_amount_spent_minor,
  drop column if exists first_seen_at;

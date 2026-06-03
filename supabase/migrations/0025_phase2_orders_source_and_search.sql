create extension if not exists pg_trgm with schema extensions;

alter table public.orders
  add column source text;

alter table public.orders
  add constraint orders_source_check
  check (
    source is null
    or source in ('shopify', 'whatsapp', 'manual', 'instagram', 'tiktok', 'facebook')
  ) not valid;

update public.orders
set source = 'shopify'
where source is null
  and shopify_order_id is not null;

create or replace function public.order_items_search_text(p_items jsonb)
returns text
language sql
immutable
set search_path = public
as $$
  select lower(
    coalesce(
      (
        select string_agg(trim(coalesce(item ->> 'title', '')), ' ')
        from jsonb_array_elements(
          case
            when jsonb_typeof(p_items) = 'array' then p_items
            else '[]'::jsonb
          end
        ) as item
        where trim(coalesce(item ->> 'title', '')) <> ''
      ),
      ''
    )
  );
$$;

create index if not exists customer_name_trgm_idx
  on public.customer
  using gin (lower(coalesce(full_name, '')) extensions.gin_trgm_ops);

create index if not exists customer_phone_trgm_idx
  on public.customer
  using gin (coalesce(phone, '') extensions.gin_trgm_ops);

create index if not exists orders_items_search_text_trgm_idx
  on public.orders
  using gin (public.order_items_search_text(items_summary) extensions.gin_trgm_ops);

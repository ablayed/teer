-- ============================================================================
-- 0151 — R2.1/R2.2 : identité CSV et création atomique de commande
-- ============================================================================
--
-- Cette migration est additive au modèle canonique L1 : une référence externe
-- peut désormais être portée soit par une store_connection, soit par un espace
-- de noms de source native. Elle ne modifie ni l'index Shopify existant, ni les
-- CHECK de plateforme.

-- external_ref portait historiquement son contexte uniquement par la jointure
-- vers store_connection. Une source native n'a pas de connexion : elle porte
-- donc directement le même couple autoritatif compte + boutique.
alter table public.external_ref
  add column merchant_account_id uuid,
  add column shop_id uuid,
  add column source_namespace text;

update public.external_ref er
set
  merchant_account_id = sc.merchant_account_id,
  shop_id = sc.shop_id
from public.store_connection sc
where sc.id = er.store_connection_id;

do $$
begin
  if exists (
    select 1
    from public.external_ref
    where merchant_account_id is null
       or shop_id is null
  ) then
    raise exception 'r2_external_ref_context_backfill_incomplete';
  end if;
end;
$$;

alter table public.external_ref
  alter column merchant_account_id set not null,
  alter column shop_id set not null,
  alter column store_connection_id drop not null;

-- Toute référence porte un contexte cohérent. MATCH SIMPLE rend cette FK sans
-- effet pour une référence CSV (store_connection_id NULL), tout en fermant la
-- combinaison connexion / compte / boutique pour les connecteurs.
alter table public.external_ref
  drop constraint external_ref_store_connection_id_fkey,
  add constraint external_ref_shop_tenant_fk
    foreign key (merchant_account_id, shop_id)
    references public.shop (merchant_account_id, id)
    on delete cascade,
  add constraint external_ref_connection_tenant_shop_fk
    foreign key (store_connection_id, merchant_account_id, shop_id)
    references public.store_connection (id, merchant_account_id, shop_id)
    on delete cascade,
  add constraint external_ref_connection_source_namespace_check
    check (
      (store_connection_id is not null and source_namespace is null)
      or (store_connection_id is null and source_namespace is not null)
    ),
  add constraint external_ref_source_namespace_check
    check (source_namespace is null or source_namespace in ('csv'));

-- L'index external_ref_connection_type_external_key reste intentionnellement
-- intact : il continue de porter l'idempotence des connecteurs existants.
create unique index external_ref_native_source_entity_external_key
  on public.external_ref (
    merchant_account_id,
    shop_id,
    source_namespace,
    entity_type,
    external_id
  )
  where store_connection_id is null;

-- La policy historique ne pouvait voir une référence qu'au travers d'une
-- connexion. Les références CSV restent visibles au seul membre de leur
-- boutique, avec le même refus par défaut inter-tenant / inter-boutique.
drop policy external_ref_select on public.external_ref;
create policy external_ref_select on public.external_ref
  for select to authenticated
  using (
    public.current_member_role(merchant_account_id) is not null
    and public.is_shop_member_of(shop_id)
  );

-- Une seule opération atomique : l'échec du claim external_ref annule aussi
-- l'insertion de la commande et de toutes ses lignes. La fonction est réservée
-- au service-role ; aucun client authentifié ne reçoit une capacité d'écriture.
create function public.create_csv_order(
  p_merchant_account_id uuid,
  p_shop_id uuid,
  p_customer_id uuid,
  p_order_key text,
  p_order_number text,
  p_total_amount numeric,
  p_currency text,
  p_items_summary jsonb,
  p_shipping_address jsonb,
  p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'r2_csv_order_lines_required';
  end if;

  if btrim(p_order_key) = '' then
    raise exception 'r2_csv_order_key_required';
  end if;

  if not exists (
    select 1
    from public.shop s
    where s.id = p_shop_id
      and s.merchant_account_id = p_merchant_account_id
  ) then
    raise exception 'r2_csv_shop_context_mismatch';
  end if;

  if p_customer_id is not null and not exists (
    select 1
    from public.customer c
    where c.id = p_customer_id
      and c.merchant_account_id = p_merchant_account_id
      and c.shop_id = p_shop_id
  ) then
    raise exception 'r2_csv_customer_context_mismatch';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_lines) as line(product_id uuid)
    left join public.product p on p.id = line.product_id
    where line.product_id is not null
      and (
        p.id is null
        or p.merchant_account_id <> p_merchant_account_id
        or p.shop_id <> p_shop_id
      )
  ) then
    raise exception 'r2_csv_product_context_mismatch';
  end if;

  insert into public.orders (
    merchant_account_id,
    shop_id,
    customer_id,
    order_number,
    total_amount,
    currency,
    items_summary,
    shipping_address,
    source,
    order_state,
    call_state,
    delivery_state,
    cash_state
  ) values (
    p_merchant_account_id,
    p_shop_id,
    p_customer_id,
    p_order_number,
    p_total_amount,
    p_currency,
    p_items_summary,
    p_shipping_address,
    'manual',
    'open',
    'to_call',
    'unassigned',
    'not_due'
  )
  returning id into v_order_id;

  insert into public.external_ref (
    merchant_account_id,
    shop_id,
    store_connection_id,
    source_namespace,
    entity_type,
    entity_id,
    external_id
  ) values (
    p_merchant_account_id,
    p_shop_id,
    null,
    'csv',
    'order',
    v_order_id,
    p_order_key
  );

  insert into public.order_line (
    merchant_account_id,
    shop_id,
    order_id,
    product_id,
    raw_title,
    raw_sku,
    qty,
    match_status
  )
  select
    p_merchant_account_id,
    p_shop_id,
    v_order_id,
    line.product_id,
    line.raw_title,
    line.raw_sku,
    line.qty,
    line.match_status
  from jsonb_to_recordset(p_lines) as line(
    product_id uuid,
    raw_title text,
    raw_sku text,
    qty integer,
    match_status text
  );

  return v_order_id;
end;
$$;

revoke all on function public.create_csv_order(
  uuid, uuid, uuid, text, text, numeric, text, jsonb, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.create_csv_order(
  uuid, uuid, uuid, text, text, numeric, text, jsonb, jsonb, jsonb
) to service_role;

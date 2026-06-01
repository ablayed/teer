alter table public.orders
  add column payment_channel_at_delivery text
    check (
      payment_channel_at_delivery in (
        'ESPECES',
        'WAVE',
        'ORANGE_MONEY',
        'FREE_MONEY',
        'INCONNU'
      )
    ),
  add column cash_collectable_minor bigint
    check (cash_collectable_minor is null or cash_collectable_minor >= 0);

update public.orders
set
  payment_channel_at_delivery = 'INCONNU',
  cash_collectable_minor = round(total_amount)::bigint
where cod_status = 'LIVREE';

create index orders_livree_merchant_status_driver_idx
  on public.orders (merchant_account_id, cod_status, assigned_driver_id)
  where cod_status = 'LIVREE';

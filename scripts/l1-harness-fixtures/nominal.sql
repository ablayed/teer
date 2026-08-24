-- Fixture nominale — harnais L1 backfill (0142), cas positif.
-- Deux tenants, deux boutiques Shopify sur deux apps distinctes, une commande
-- manuelle sans shopify_order_id, un client sans GID, deux variantes du même
-- produit Shopify, des webhooks à payload nullé (0121) mais boutique résolue.
-- Isolée : n'a aucune interaction avec supabase/seed.sql.

insert into auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, aud, role)
values
  ('a0000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'l1-fixture-tenant1@example.com', 'x', now(), 'authenticated', 'authenticated'),
  ('a0000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'l1-fixture-tenant2@example.com', 'x', now(), 'authenticated', 'authenticated');

insert into public.merchant_account (id, name, owner_user_id) values
  ('b0000000-0000-0000-0000-000000000001', 'L1 Fixture Tenant 1', 'a0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002', 'L1 Fixture Tenant 2', 'a0000000-0000-0000-0000-000000000002');

-- Tenant 1 : boutique Shopify sur l'app "koba".
insert into public.shop (id, merchant_account_id, shop_domain, access_token_encrypted, scopes, status, display_name, store_kind, is_default, shopify_client_id)
values ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'l1-fixture-tenant1.myshopify.com', 'enc', 'read_orders', 'active', 'Boutique Fixture 1', 'shopify', true, 'client-koba-test');

-- Tenant 2 : boutique Shopify sur l'app "pilote", domaine distinct.
insert into public.shop (id, merchant_account_id, shop_domain, access_token_encrypted, scopes, status, display_name, store_kind, is_default, shopify_client_id)
values ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'l1-fixture-tenant2.myshopify.com', 'enc', 'read_orders', 'active', 'Boutique Fixture 2', 'shopify', true, 'client-pilote-test');

insert into public.orders (id, merchant_account_id, shop_id, order_number, total_amount, currency, cod_status, order_state, call_state, delivery_state, cash_state, shopify_order_id)
values
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'fixture-order-t1-1', 1000, 'XOF', 'A_APPELER', 'open', 'to_call', 'unassigned', 'not_due', 'shopify-order-t1-1'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'fixture-order-t1-2', 2000, 'XOF', 'A_APPELER', 'open', 'to_call', 'unassigned', 'not_due', 'shopify-order-t1-2'),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'fixture-order-t2-1', 1500, 'XOF', 'A_APPELER', 'open', 'to_call', 'unassigned', 'not_due', 'shopify-order-t2-1'),
  ('d0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'fixture-order-manual', 500, 'XOF', 'A_APPELER', 'open', 'to_call', 'unassigned', 'not_due', null);

insert into public.customer (id, merchant_account_id, shop_id, full_name, phone, shopify_customer_gids)
values
  ('e0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Client Fixture 1', '+221700000001', '["gid://shopify/Customer/1","gid://shopify/Customer/2"]'::jsonb),
  ('e0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'Client Fixture 2', '+221700000002', '["gid://shopify/Customer/3"]'::jsonb),
  ('e0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Client Fixture Manuel', '+221700000003', '[]'::jsonb);

insert into public.product (id, merchant_account_id, shop_id, shopify_product_id, shopify_variant_id, title)
values
  ('f0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'shopify-product-shared', 'shopify-variant-t1-a', 'Produit Fixture 1 - variante A'),
  ('f0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'shopify-product-shared', 'shopify-variant-t1-b', 'Produit Fixture 1 - variante B'),
  ('f0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'shopify-product-other', 'shopify-variant-t2-a', 'Produit Fixture 2');

insert into public.webhook_event (shopify_webhook_id, topic, shop_domain, shop_id, merchant_account_id, status, payload, received_at, triggered_at)
values
  ('fixture-wh-t1-1', 'orders/create', 'l1-fixture-tenant1.myshopify.com', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'done', null, now() - interval '2 days', now() - interval '2 days'),
  ('fixture-wh-t1-2', 'orders/updated', 'l1-fixture-tenant1.myshopify.com', 'c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'retryable', '{"id": 1}'::jsonb, now() - interval '1 day', now() - interval '1 day'),
  ('fixture-wh-t2-1', 'app/uninstalled', 'l1-fixture-tenant2.myshopify.com', 'c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'terminal', null, now() - interval '3 days', now() - interval '3 days');

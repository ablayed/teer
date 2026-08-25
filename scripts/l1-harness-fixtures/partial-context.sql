-- Fixture — harnais L1 backfill (0142), cas (2) : contexte PARTIEL.
-- Une seule des deux colonnes (merchant_account_id, shop_id) est nulle —
-- jamais les deux. La migration doit échouer quel que soit le statut
-- (terminé ou non) : un contexte à moitié établi est une donnée dont
-- personne ne sait ce qu'elle vaut, pas une variante bénigne du cas exclu.
-- Isolée : n'a aucune interaction avec supabase/seed.sql ni nominal.sql.
insert into auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, aud, role)
values ('a0000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'l1-fixture-partial@example.com', 'x', now(), 'authenticated', 'authenticated');

insert into public.merchant_account (id, name, owner_user_id)
values ('b0000000-0000-0000-0000-000000000006', 'L1 Fixture Partial', 'a0000000-0000-0000-0000-000000000006');

insert into public.shop (id, merchant_account_id, shop_domain, access_token_encrypted, scopes, status, display_name, store_kind, is_default, shopify_client_id)
values ('c0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000006', 'l1-fixture-partial.myshopify.com', 'enc', 'read_orders', 'active', 'Boutique Fixture Partial', 'shopify', true, 'client-partial-test');

insert into public.webhook_event (shopify_webhook_id, topic, shop_domain, shop_id, merchant_account_id, status, payload, received_at)
values
  -- Orientation A : merchant_account_id renseigné, shop_id nul. Terminée
  -- (statut le plus favorable possible) — doit quand même échouer.
  ('fixture-partial-a', 'orders/create', 'l1-fixture-partial.myshopify.com', null, 'b0000000-0000-0000-0000-000000000006', 'done', null, now() - interval '4 days'),
  -- Orientation B : shop_id renseigné, merchant_account_id nul. Terminée
  -- aussi — même exigence, même échec attendu.
  ('fixture-partial-b', 'orders/create', 'l1-fixture-partial.myshopify.com', 'c0000000-0000-0000-0000-000000000006', null, 'terminal', null, now() - interval '4 days' + interval '30 seconds');

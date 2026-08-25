-- Fixture — harnais L1 backfill (0142), cas (1) et (5) : boutique non
-- résoluble À L'ÉCRITURE, ligne TERMINÉE. Isolée : n'a aucune interaction
-- avec supabase/seed.sql ni nominal.sql (chargée seule après un
-- `db reset --local` propre).
--
-- Reproduit le cas prod réel (2026-05-30, outil "Send test notification"
-- Shopify, domaine générique jamais enregistré) — et, plus largement, la
-- classe des 8 lignes trouvées par le préflight production du 25 août 2026,
-- toutes `status in ('done','terminal')`. shop_id/merchant_account_id sont
-- NULL parce que recordWebhookReceipt (app/api/shopify/webhooks/route.ts)
-- n'a trouvé aucune boutique correspondant au domaine à l'écriture — PAS une
-- conséquence du nullage de `payload` par 0121 (mécanisme différent, colonne
-- stable posée à l'écriture, jamais recalculée).
--
-- CORRECTION L1-bis : ce cas a CHANGÉ DE VERDICT. Il attendait auparavant un
-- échec ; ces lignes sont terminées, donc 0142 doit désormais RÉUSSIR et les
-- exclure du backfill (comptées, jamais insérées dans ingestion_event). Le
-- cas qui doit encore échouer (non terminal sans contexte) vit dans
-- in-flight-no-context.sql, à côté ; les cas de contexte partiel vivent dans
-- partial-context.sql.
insert into auth.users (id, instance_id, email, encrypted_password, email_confirmed_at, aud, role)
values ('a0000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'l1-fixture-neg@example.com', 'x', now(), 'authenticated', 'authenticated');

insert into public.merchant_account (id, name, owner_user_id)
values ('b0000000-0000-0000-0000-000000000005', 'L1 Fixture Neg', 'a0000000-0000-0000-0000-000000000005');

-- Boutique réellement enregistrée sous ce domaine — preuve que l'exclusion
-- ne dépend jamais de la résolvabilité du domaine, seulement de l'absence
-- de contexte posée à l'écriture. Ni le préflight ni le backfill ne lisent
-- `shop_domain` : cette ligne shop n'est là que pour rendre le cas honnête.
insert into public.shop (id, merchant_account_id, shop_domain, access_token_encrypted, scopes, status, display_name, store_kind, is_default, shopify_client_id)
values ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000005', 'l1-fixture-neg-resolvable.myshopify.com', 'enc', 'read_orders', 'active', 'Boutique Fixture Neg', 'shopify', true, 'client-neg-test');

insert into public.webhook_event (shopify_webhook_id, topic, shop_domain, shop_id, merchant_account_id, status, payload, received_at)
values
  -- (1) domaine générique jamais enregistré nulle part, terminée en 'done'.
  ('fixture-neg-orphan-1', 'orders/create', 'shop.myshopify.com', null, null, 'done', null, now() - interval '5 days'),
  -- (1) même domaine générique, terminée en 'terminal' (l'autre sortie
  -- définitive de finish_shopify_webhook_event).
  ('fixture-neg-orphan-2', 'orders/create', 'shop.myshopify.com', null, null, 'terminal', null, now() - interval '5 days' + interval '30 seconds'),
  -- (5) domaine RÉSOLVABLE (la boutique ci-dessus existe réellement), mais
  -- shop_id/merchant_account_id nuls quand même : preuve que la décision ne
  -- dépend jamais de la résolvabilité du domaine.
  ('fixture-neg-orphan-3', 'orders/create', 'l1-fixture-neg-resolvable.myshopify.com', null, null, 'done', null, now() - interval '5 days' + interval '60 seconds');

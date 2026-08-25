-- Fixture — harnais L1 backfill (0142), cas (3) : contexte totalement
-- absent MAIS ligne NON terminée (encore en vol). Ce cas doit continuer
-- d'échouer après la correction L1-bis : un événement encore
-- `processing`/`retryable` ne peut pas être silencieusement absent du
-- nouveau registre canonique — contrairement au cas (1)/(5), terminé, qui
-- lui est désormais exclu sans bloquer. Isolée : n'a aucune interaction avec
-- supabase/seed.sql ni nominal.sql.
insert into public.webhook_event (shopify_webhook_id, topic, shop_domain, shop_id, merchant_account_id, status, payload, received_at, next_attempt_at)
values
  -- 'retryable' : en attente de rejeu.
  ('fixture-inflight-1', 'orders/create', 'shop.myshopify.com', null, null, 'retryable', '{"id": 1}'::jsonb, now() - interval '2 hours', now() + interval '5 minutes'),
  -- 'processing' : en cours de traitement (lease active ou expirée).
  ('fixture-inflight-2', 'orders/updated', 'shop.myshopify.com', null, null, 'processing', '{"id": 2}'::jsonb, now() - interval '10 minutes', null);

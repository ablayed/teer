-- Fixture négative — harnais L1 backfill (0142).
-- webhook_event dont la boutique n'est pas résoluble : reproduit le cas prod
-- réel (2026-05-30, outil "Send test notification" Shopify, domaine générique
-- jamais enregistré). shop_id/merchant_account_id sont NULL parce que
-- recordWebhookReceipt (app/api/shopify/webhooks/route.ts) n'a trouvé aucune
-- boutique correspondant au domaine à l'écriture — PAS une conséquence du
-- nullage de `payload` par 0121 (mécanisme différent, colonne stable posée à
-- l'écriture, jamais recalculée).
insert into public.webhook_event (shopify_webhook_id, topic, shop_domain, shop_id, merchant_account_id, status, payload, received_at)
values
  ('fixture-neg-orphan-1', 'orders/create', 'shop.myshopify.com', null, null, 'done', null, now() - interval '5 days'),
  ('fixture-neg-orphan-2', 'orders/create', 'shop.myshopify.com', null, null, 'done', null, now() - interval '5 days' + interval '30 seconds');

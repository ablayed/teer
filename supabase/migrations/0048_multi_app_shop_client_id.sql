-- Multi-app Shopify (Teer Dev publique + Teer Pilote custom) sur un seul déploiement.
-- On enregistre QUEL client_id (= app Shopify) a installé chaque boutique, afin de router
-- la vérification HMAC des webhooks et la sélection des credentials (refresh / bulk / reconcile)
-- vers le bon secret par app. Base Supabase PARTAGÉE : le tenant (merchant_account) ne change pas.
--
-- Nullable d'abord (règle : nouvelles colonnes nullables). Backfill = Teer Dev (toutes les
-- installations actuelles sont passées par l'app publique Teer Dev), afin que le routage des
-- boutiques existantes reste déterministe sans dépendre des headers webhook (Shopify n'envoie
-- pas de client_id dans les webhooks). Pas de NOT NULL ici : une boutique sans client_id connu
-- retombera sur l'app par défaut côté code.

ALTER TABLE shop ADD COLUMN shopify_client_id text;

-- Backfill : les boutiques déjà connectées l'ont été via Teer Dev (client_id de shopify.app.toml).
UPDATE shop
SET shopify_client_id = '1d6727179a64b9d78a8466802c16ca3a'
WHERE shopify_client_id IS NULL;

COMMENT ON COLUMN shop.shopify_client_id IS
  'client_id de l''app Shopify ayant installé cette boutique (multi-app : Teer Dev / Teer Pilote). '
  'Sert au routage du secret HMAC webhooks et des credentials sortants. Backfill = Teer Dev.';

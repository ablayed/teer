-- Capture générique des attributs personnalisés Shopify (note, customAttributes commande,
-- customAttributes de ligne) — affichage brut uniquement, aucune logique métier dessus.
-- Nullable, sans backfill : uniquement les commandes synchronisées à partir de ce lot.
alter table public.orders
  add column if not exists shopify_order_attributes jsonb,
  add column if not exists shopify_line_item_attributes jsonb;

-- Phase 1 — grants de colonne manquants sur shop_id.
--
-- PROBLÈME CORRIGÉ
-- 0126 ajoute la colonne `shop_id` (puis la passe NOT NULL) sur les tables
-- métier store-scopées, mais NE met pas à jour les grants de COLONNE posés par
-- les migrations d'origine (0027 product, 0028 product_stock, 0107
-- product_bundle_component, etc.). Ces tables suivent un modèle de grants
-- restrictif — `revoke all ... from authenticated` puis `grant select (col, …)`
-- colonne par colonne — donc toute colonne ajoutée après coup n'est accessible
-- à `authenticated` par AUCUN privilège tant qu'elle n'est pas explicitement
-- accordée.
--
-- Conséquence observée (E2E products-bundle-configuration, reproduite en direct
-- contre la base locale) : `saveBundleConfigurationAction` passe par
-- `ctx.supabase` (client cookie, RLS) et filtre `.eq('shop_id', shopId)` puis
-- insère `shop_id`. PostgreSQL exige le privilège SELECT sur toute colonne lue
-- dans une clause WHERE, et INSERT sur toute colonne écrite → l'ordre échoue en
-- « permission denied for table product » / « … for table
-- product_bundle_component », l'action retourne `update_failed` et l'UI affiche
-- « Impossible d'enregistrer la configuration. Réessayez. ».
--
-- Ce n'est PAS un défaut de policy RLS : les policies de 0127 sont correctes.
-- Les grants sont évalués AVANT les policies, donc aucune policy ne pouvait
-- rattraper l'absence de privilège de colonne.
--
-- PÉRIMÈTRE
-- Les 7 tables qui possèdent des grants de colonne pour `authenticated` et qui
-- ont reçu `shop_id` en 0126. Les tables sans aucun grant `authenticated`
-- (accédées exclusivement par le client service-role) ne sont volontairement pas
-- touchées : leur donner un privilège élargirait la surface sans besoin.
--
-- SELECT + INSERT UNIQUEMENT, JAMAIS UPDATE — décision délibérée.
-- Aucun chemin applicatif ne met à jour `shop_id` (vérifié : la colonne
-- n'apparaît que dans des filtres `.eq()` et dans les payloads d'insertion).
-- Accorder UPDATE permettrait de DÉPLACER une ligne d'une boutique à une autre ;
-- les policies `with check` empêcheraient le déplacement vers une boutique non
-- autorisée, mais pas entre deux boutiques du même utilisateur — un
-- déplacement silencieux de stock ou de commande qu'aucune fonctionnalité ne
-- demande. Si un jour un transfert inter-boutiques devient un vrai geste
-- produit, il devra passer par une RPC dédiée et auditée, pas par ce grant.

-- Filtrage et lecture (SELECT) — requis par toute clause WHERE sur shop_id.
grant select (shop_id) on public.order_line to authenticated;
grant select (shop_id) on public.product to authenticated;
grant select (shop_id) on public.product_bundle_component to authenticated;
grant select (shop_id) on public.product_stock to authenticated;
grant select (shop_id) on public.purchase_lot to authenticated;
grant select (shop_id) on public.purchase_lot_line to authenticated;
grant select (shop_id) on public.stock_movement to authenticated;

-- Écriture à la création (INSERT) — uniquement pour les tables qui accordent
-- déjà INSERT à `authenticated`. `product_stock` et `stock_movement` restent en
-- lecture seule pour ce rôle : elles sont alimentées par les RPC de stock
-- (`post_stock_movement`), jamais par une insertion applicative directe.
grant insert (shop_id) on public.order_line to authenticated;
grant insert (shop_id) on public.product to authenticated;
grant insert (shop_id) on public.product_bundle_component to authenticated;
grant insert (shop_id) on public.purchase_lot to authenticated;
grant insert (shop_id) on public.purchase_lot_line to authenticated;

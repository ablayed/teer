-- Migration 0036 : index composite keyset pour la pagination produit
--
-- Objectif : supporter la pagination keyset stable sur (lower(title), id)
-- triée A-Z, filtrée par tenant.
--
-- Requête cible :
--   WHERE merchant_account_id = $1
--     AND (lower(title), id) > ($cursor_title, $cursor_id)   -- keyset cursor
--   ORDER BY lower(title), id
--   LIMIT 26
--
-- L'index GIN trigram sur lower(title) (0027, product_title_trgm_idx) reste
-- utilisé pour la recherche ILIKE. Postgres peut combiner les deux index.
-- L'index updated_at DESC (actuel .order('updated_at')) n'est plus le tri
-- primaire côté catalogue — le tri passe en A-Z stable.

create index product_keyset_idx
  on public.product (merchant_account_id, lower(title), id);

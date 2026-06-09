-- ============================================================
-- 0044 : Phase 9 — P1-8 pagination keyset liste commandes (index)
-- ============================================================
-- Mesure Stage 0 : la liste « Toutes » est O(n) (seq scan + top-N sort, current_member_role
-- par ligne, AUCUN limit) → 30 ms @1k, 399 ms @20k. Preuve qu'un index aligné + LIMIT donne
-- un index scan à terminaison anticipée (~0,5 ms @20k, 350×).
--
-- PROBLÈME D'ALIGNEMENT : le tri AFFICHÉ n'est pas `created_at_shopify DESC NULLS LAST`
-- (l'ordre DB est ré-trié EN MÉMOIRE par compareOrdersForSavedView). La vraie clé est :
--   • 7 vues  : COALESCE(created_at_shopify, created_at) DESC   (queueDate)
--   • tentée  : COALESCE(next_contact_at, created_at_shopify, created_at) ASC
-- PostgREST ne sait pas trier sur une expression brute → on matérialise la clé en colonne
-- générée STORED (auto-maintenue, sans trigger, jamais NULL car created_at est NOT NULL)
-- + index composite (merchant_account_id, clé, id) pour servir le keyset (clé, id) < (curseur).
--
-- Colonnes GÉNÉRÉES (pas le motif « nullable d'abord ») : calculées par Postgres, en lecture
-- seule, jamais NULL, ne peuvent JAMAIS rejeter une transition (rien ne les écrit). Sûr.
-- Note : ADD COLUMN ... GENERATED STORED réécrit la table (rapide en pré-launch) ; les
-- CREATE INDEX verrouillent brièvement à l'échelle actuelle. À fort volume futur : CONCURRENTLY.
-- ============================================================

alter table public.orders
  add column sort_at timestamptz
    generated always as (coalesce(created_at_shopify, created_at)) stored;

alter table public.orders
  add column next_action_at timestamptz
    generated always as (coalesce(next_contact_at, created_at_shopify, created_at)) stored;

-- Clé principale (vues toutes / à appeler / confirmée / à livrer / cash / annulées / retours) :
-- tri DESC, keyset (sort_at, id) < (curseur) → ORDER BY sort_at DESC, id DESC LIMIT n.
create index orders_merchant_sort_at_idx
  on public.orders (merchant_account_id, sort_at desc, id desc);

-- Clé de la vue « Tentée / À rappeler » : tri ASC sur next_action_at.
create index orders_merchant_next_action_idx
  on public.orders (merchant_account_id, next_action_at asc, id asc);

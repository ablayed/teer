-- 0157 : cash_aging vieillit le cash sur `orders.cash_collected_at` et exclut les dates
-- inconnues (lot COHERENCE-01)
--
-- ============================================================
-- DÉFAUT CORRIGÉ
-- ============================================================
-- `cash_aging` (0017:183-252) datait la livraison par
--
--     delivered_at = coalesce(max(order_state_transition.created_at WHERE to_status='LIVREE'),
--                             orders.updated_at)
--
-- c'est-à-dire l'INSTANT DU CLIC SERVEUR — exactement ce que 0119 a corrigé partout
-- ailleurs. Elle n'a jamais été repassée, et personne ne l'avait notée comme
-- volontairement exclue : le silence n'est pas une décision. Ses buckets d'ancienneté
-- (<1 j / 1-3 j / >3 j) alimentent le graphe « Cash-aging par livreur » de /finances, et
-- son décompte alimente « Livreurs concernés ».
--
-- EFFET VISIBLE, ET SON SENS : une commande livrée le 24 et cliquée le 26 était vieillie
-- de DEUX JOURS DE MOINS qu'elle ne l'est réellement. Après cette migration, des commandes
-- que le marchand voit aujourd'hui CHANGENT DE BUCKET, en général vers le PLUS VIEUX.
-- Ce n'est pas une régression, c'est la correction.
--
-- Le repli `orders.updated_at` était plus grave encore que l'axe : `updated_at` est
-- `NOT NULL DEFAULT now()` et entretenue par le trigger `orders_set_updated_at`
-- (0005:93). Toute modification ultérieure de la commande — une note d'équipe, une
-- resynchronisation Shopify — RAJEUNISSAIT donc l'ancienneté de son cash.
--
-- ============================================================
-- CE QUE CETTE MÉTRIQUE MESURE — décision, à ne pas déduire du nom de la colonne
-- ============================================================
-- `cash_collected_at` N'EST PAS l'instant physique où le livreur a encaissé. Sa valeur
-- peut être héritée de `scheduled_for` (0148:304 :
-- `coalesce(p_delivered_at, v_order.scheduled_for, now())`), donc d'une date convenue à
-- l'avance. C'est la DATE DE RECORD COMPTABLE DE LA VENTE.
--
-- Décision inscrite ici, et reprise mot pour mot dans la microcopie de la carte
-- (`finance.charts.agingScope`, messages/fr.json) :
--
--     Tëër choisit une ANCIENNETÉ FINANCIÈRE cohérente avec le CA et le P&L, fondée sur
--     `cash_collected_at`, et EXCLUT les lignes dont cette date est inconnue.
--
-- L'ALIAS INTERNE EST RENOMMÉ `delivered_at` → `financial_at`, et ce n'est pas cosmétique.
-- `0017` appelait cette colonne `delivered_at` quand elle valait l'instant du clic « livrée ».
-- Elle vaut désormais une date de record comptable, héritable de `scheduled_for` : garder le
-- nom `delivered_at` recréerait À L'INTÉRIEUR de la fonction exactement la confusion que ce
-- lot corrige à l'extérieur — un lecteur en déduirait une date de livraison physique.
-- `0156` garde, lui, le nom `delivered_at` : son expression EST celle de
-- `finance_kpis.delivered_orders` (`0119`:73), qu'il recopie délibérément pour que les deux
-- se recoupent, et là le nom reste juste (meilleure date de livraison connue). L'asymétrie
-- des deux noms est donc voulue, et suit le sens de chaque valeur.
--
-- UN ÂGE PHYSIQUE RÉEL DU CASH N'EST PAS CE LOT. Il exigerait d'enregistrer un événement
-- de collecte réellement horodaté, qui n'existe nulle part dans le schéma. Ne pas le
-- simuler, et ne jamais présenter l'âge financier comme un âge physique — ce serait
-- exactement l'écart entre le dit et le fait que ce lot ferme ailleurs.
--
-- ============================================================
-- LE REPLI EST RETIRÉ, PAS REMPLACÉ
-- ============================================================
-- Si `cash_collected_at` est NULL, l'ancienneté n'est pas connue, et une valeur inventée
-- vaut moins qu'une absence. La ligne est donc exclue (`cash_collected_at is not null`).
--
-- AMPLEUR MESURÉE AVANT D'ÉCRIRE CETTE MIGRATION, décision du porteur : SIX lignes en
-- production ont `cash_state='collected'` et `cash_collected_at is null`. Toutes
-- `cod_status='LIVREE'`, toutes créées le 3 juin 2026 dans un intervalle de 135 secondes
-- — donc antérieures à 0119 et issues d'une insertion en lot. Le chemin d'écriture actuel
-- ne reproduit pas ce cas : aucune occurrence depuis trois mois et demi.
-- Exclusion retenue en connaissance de cause : une ancienneté calculée sur des données de
-- juin afficherait plus de cent jours de cash traînant, plus trompeur que l'absence.
-- Leur montant RESTE VISIBLE dans « Cash chez les livreurs » et « Cash total chez tous les
-- livreurs », qui n'ont aucune fenêtre temporelle et ne passent pas par cette fonction
-- (`finance_kpis.cash_chez_livreurs`, 0119:88-135). Rien n'est perdu de vue ; seule
-- l'ancienneté, qui n'est pas connue, n'est plus inventée.
-- Dette de données antérieure à 0119, NON backfillée — nommée, pas corrigée ici.
--
-- Noter l'asymétrie avec 0156, qui CONSERVE le repli de `finance_kpis` : là, l'objet est
-- qu'un graphe se recoupe avec le KPI posé dans le même document, donc le repli doit être
-- le même que le sien. Ici l'objet est une ancienneté. Même colonne, deux usages, deux
-- traitements du NULL, les deux explicites.
--
-- ============================================================
-- EFFET DE BORD INÉVITABLE, À NE PAS DÉCOUVRIR PLUS TARD
-- ============================================================
-- Le `left join public.order_state_transition` disparaît : il ne servait plus qu'à calculer
-- l'ancien `delivered_at`. Or ce join COEXISTAIT avec le `left join public.settlement_allocation`
-- sous le même `group by o.id` : les deux produisaient un produit cartésien. Une commande
-- ayant N transitions `LIVREE` faisait donc compter `sum(sa.allocated_minor)` N FOIS, et
-- son `outstanding_minor` s'en trouvait SOUS-ÉVALUÉ (voire ramené à 0 par le `greatest`).
-- `max(ost.created_at)` était insensible à cette démultiplication ; la somme ne l'était pas.
-- Retirer le join supprime ce défaut latent. Ce n'est pas une correction opportuniste :
-- c'est une conséquence mécanique et inséparable du changement d'axe, et elle est nommée
-- ici plutôt que laissée à découvrir.
--
-- ============================================================
-- CE QUI N'EST PAS CHANGÉ
-- ============================================================
--   - La garde de rôle, par filtre `WHERE ... in ('owner','manager')` : NULL-safe par
--     construction (un NULL ne satisfait pas le prédicat → zéro ligne), conforme à 0043.
--   - Le périmètre : `cod_status='LIVREE'`, `assigned_driver_id is not null`, canal de
--     paiement `in ('ESPECES','INCONNU')`, `outstanding_minor > 0`.
--   - Les bornes de bucket (<1 j / 1-3 j / >3 j), comparées à `now()`.
--   - `cash_aging` n'a jamais eu de paramètre boutique et n'en reçoit pas : la portée
--     LOCATAIRE du cash livreur est une décision figée, pas un oubli.
--   - Le type de retour, à l'identique (6 colonnes).
--
-- ============================================================
-- FORME
-- ============================================================
-- `create or replace function` à SIGNATURE IDENTIQUE (uuid) et type de retour identique :
-- l'ACL existante est PRÉSERVÉE, là où un DROP + CREATE réouvrirait `EXECUTE` à `PUBLIC`.
-- Le `revoke`/`grant` ci-dessous ré-affirme à l'identique ce que 0017:252 et 0140:148
-- avaient posé — ce n'est pas un changement : `proacl` doit être mesuré IDENTIQUE avant
-- et après, et c'est `pg_proc.proacl` / `has_function_privilege` qui font foi, jamais la
-- présence de ces instructions dans le texte.
--
-- Aucun changement TypeScript : signature, noms et types de colonnes inchangés, donc
-- `lib/supabase/database.types.ts` est inchangé.
-- ============================================================

create or replace function public.cash_aging(p_merchant uuid)
returns table (
  driver_id uuid,
  driver_name text,
  bucket_lt1d bigint,
  bucket_1_3d bigint,
  bucket_gt3d bigint,
  outstanding_minor bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with role_guard as (
    select public.current_member_role(p_merchant) as role
  ),
  delivered_cash_orders as (
    select
      o.id,
      o.assigned_driver_id,
      -- 0157 : ancienneté FINANCIÈRE, sur la date de record comptable de la vente.
      -- Aucun repli : une date de collecte inconnue est exclue par le prédicat ci-dessous,
      -- jamais remplacée par l'instant du clic ni par `updated_at`.
      o.cash_collected_at as financial_at,
      greatest(
        coalesce(o.cash_collectable_minor, round(o.total_amount)::bigint)
          - coalesce(sum(sa.allocated_minor), 0),
        0
      ) as outstanding_minor
    from public.orders o
    left join public.settlement_allocation sa
      on sa.order_id = o.id
     and sa.merchant_account_id = o.merchant_account_id
    where o.merchant_account_id = p_merchant
      and o.cod_status = 'LIVREE'
      and o.assigned_driver_id is not null
      -- Exclusion explicite, décision du §« LE REPLI EST RETIRÉ » ci-dessus.
      and o.cash_collected_at is not null
      and coalesce(o.payment_channel_at_delivery, 'INCONNU') in ('ESPECES','INCONNU')
      and (select role from role_guard) in ('owner','manager')
    group by o.id, o.assigned_driver_id, o.cash_collected_at, o.cash_collectable_minor,
             o.total_amount
  ),
  outstanding as (
    select *
    from delivered_cash_orders
    where outstanding_minor > 0
  )
  select
    d.id as driver_id,
    d.full_name as driver_name,
    coalesce(sum(o.outstanding_minor) filter (
      where now() - o.financial_at < interval '1 day'
    ), 0)::bigint as bucket_lt1d,
    coalesce(sum(o.outstanding_minor) filter (
      where now() - o.financial_at >= interval '1 day'
        and now() - o.financial_at <= interval '3 days'
    ), 0)::bigint as bucket_1_3d,
    coalesce(sum(o.outstanding_minor) filter (
      where now() - o.financial_at > interval '3 days'
    ), 0)::bigint as bucket_gt3d,
    coalesce(sum(o.outstanding_minor), 0)::bigint as outstanding_minor
  from outstanding o
  join public.driver d
    on d.id = o.assigned_driver_id
   and d.merchant_account_id = p_merchant
  where (select role from role_guard) in ('owner','manager')
  group by d.id, d.full_name
  order by outstanding_minor desc, d.full_name;
$$;

-- Ré-affirmation à l'identique de l'ACL de 0017:252 et 0140:148. À vérifier au catalogue
-- (`pg_proc.proacl`), jamais à déduire de ces deux lignes.
revoke all on function public.cash_aging(uuid) from public, anon;

grant execute on function public.cash_aging(uuid) to authenticated;

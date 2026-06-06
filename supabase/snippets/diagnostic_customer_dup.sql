-- Phase 7b — diagnostic des collisions de dédup AVANT la migration 0038.
-- À lancer en lecture seule (SQL editor) pour mesurer l'ampleur du dédoublonnage.
-- La normalisation utilisée est identique au helper public.sn_phone_e164 de 0038.

with normalized as (
  select
    id,
    merchant_account_id,
    phone,
    case
      when phone is null then null
      else (
        with d as (
          select regexp_replace(btrim(phone), '\D', '', 'g') as v
        ),
        s1 as (select case when left(v, 2) = '00' then substr(v, 3) else v end as v from d),
        s2 as (select case when left(v, 3) = '221' then substr(v, 4) else v end as v from s1),
        s3 as (select case when left(v, 1) = '0' then substr(v, 2) else v end as v from s2)
        select case when v ~ '^\d{9}$' then '+221' || v else null end from s3
      )
    end as phone_e164
  from public.customer
)
select
  count(*) filter (where phone is not null and phone_e164 is null)
    as phones_non_normalisables,
  (
    select coalesce(sum(cnt - 1), 0)
    from (
      select count(*) as cnt
      from normalized
      where phone_e164 is not null
      group by merchant_account_id, phone_e164
      having count(*) > 1
    ) g
  ) as lignes_a_fusionner,
  (
    select count(*)
    from (
      select 1
      from normalized
      where phone_e164 is not null
      group by merchant_account_id, phone_e164
      having count(*) > 1
    ) g
  ) as groupes_en_collision;

-- Détail des groupes en collision (qui sera fusionné par 0038) :
-- with normalized as ( ... même CTE ... )
-- select merchant_account_id, phone_e164, count(*), array_agg(id order by id)
-- from normalized where phone_e164 is not null
-- group by merchant_account_id, phone_e164 having count(*) > 1;

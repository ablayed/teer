# Convention — droits explicites pour tout objet neuf (lot D)

**Règle.** Toute migration qui crée une table, une vue, une séquence ou une fonction pose, dans **le même
fichier**, les droits de cet objet : elle le **ferme** pour tous les rôles nommés, puis l'**ouvre** au
strict nécessaire. Rien pour `anon` sauf besoin prouvé.

## Pourquoi maintenant

- **[Fait]** Jusqu'ici, une nouvelle table naissait avec les droits par défaut de l'image : `anon`,
  `authenticated` et `service_role` y ont `arwdDxtm`, et seule la RLS la protège. Sur les 60 tables de la
  baseline ACL, 26 dépendent encore de ce défaut ; aucune n'a de politique pour `anon`, donc l'accès
  effectif d'`anon` est nul, mais à **une seule couche**.
- **[Rapporté par le porteur, 2026-10-19]** À partir du **30/10**, Supabase n'expose plus automatiquement
  les nouveaux objets à l'API Data ; les objets existants gardent leurs droits.
- **[Fait]** Une image qui applique ce régime existe déjà : celle de la CLI 2.110.0 (PostgreSQL 17.6.1.143)
  ramène les droits par défaut des nouvelles tables à `Dxtm`. Mesuré : 543 échecs sur 803 en `test:rls`
  quand les migrations s'appuient sur le défaut.
- **Conséquence** : une migration qui s'appuie sur le défaut passe sur la pile locale actuelle et casse en
  production après le 30/10. Une migration qui pose ses droits explicitement fonctionne dans les deux
  régimes. **Toute migration qui crée un objet attend que cette garde soit en place.**

## Modèles à copier

### Table

```sql
create table public.ma_table (
  id uuid primary key default gen_random_uuid(),
  merchant_account_id uuid not null
);

alter table public.ma_table enable row level security;
alter table public.ma_table force row level security;

-- 1. Fermer pour TOUS les rôles nommés (« from public » seul est un no-op sur Supabase).
revoke all on table public.ma_table from public, anon, authenticated, service_role;

-- 2. Ouvrir au strict nécessaire, verbe par verbe.
grant select, insert, update on table public.ma_table to authenticated;
grant select, insert, update, delete on table public.ma_table to service_role;
```

Les verbes accordés à `authenticated` doivent correspondre aux politiques RLS existantes (un verbe sans
politique est un sur-droit ; voir le plan, lot C).

### Table réservée au serveur (aucun droit pour `authenticated`)

```sql
-- droits-explicites: aucun public.ma_table_interne
create table public.ma_table_interne (id uuid primary key);
alter table public.ma_table_interne enable row level security;
alter table public.ma_table_interne force row level security;
revoke all on table public.ma_table_interne from public, anon, authenticated, service_role;
```

Le marqueur **nomme l'objet** et ne dispense jamais de fermer `anon`. À réserver aux tables lues
uniquement par des fonctions `SECURITY DEFINER` ou par le propriétaire.

### Vue

```sql
create view public.ma_vue
  with (security_invoker = true)   -- sinon la vue contourne la RLS des tables sous-jacentes
  as select ...;

revoke all on table public.ma_vue from public, anon, authenticated, service_role;
grant select on table public.ma_vue to authenticated;
```

### Séquence nommée

```sql
create sequence public.ma_sequence;
revoke all on sequence public.ma_sequence from public, anon, authenticated, service_role;
grant usage on sequence public.ma_sequence to service_role;
```

(Les séquences implicites d'une colonne `serial` ou `identity` ne sont pas concernées.)

### Fonction

```sql
create function public.ma_fonction(p_id uuid) returns integer
language sql stable security invoker set search_path = '' as $$ ... $$;

revoke all on function public.ma_fonction(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ma_fonction(uuid) to authenticated;
```

Les fonctions `returns trigger` sont exemptées (PostgreSQL refuse leur invocation directe).
`create or replace` d'une fonction **déjà connue** conserve son ACL : ce n'est pas un objet neuf.

## Ce qui est vérifié, et par quoi

| Couche | Fichier | Nature |
|---|---|---|
| Statique | `tests/unit/security/lot-d-explicit-grants.test.ts` (+ `tests/helpers/migration-grants.ts`) | Filet de **revue** : présence textuelle, migrations ≥ 0168. R1 `REVOKE` nommant `anon` ; R2 `GRANT` explicite à `authenticated`/`service_role` (ou marqueur) ; R3 aucun `GRANT` à `anon`/`public` ; R5 vue `security_invoker`. |
| Vivante | `tests/rls/anon-privilege-frozen-allowlist.rls.test.ts` | **Preuve** : `has_table_privilege`/`has_sequence_privilege` réels. Toute relation où `anon` a un droit doit figurer dans `supabase/security/anon-privilege-allowlist.json`. |
| Fonctions | `tests/rls/function-execute-acl-invariant.rls.test.ts`, `tests/unit/security/lot4a-migration-revoke-pairing.test.ts` | Existantes (lot 4A). |

## Devant un rouge

- **Jamais** « régénérer » ni ajouter un nom à la liste : on corrige la migration (elle ferme la relation).
- `supabase/security/anon-privilege-allowlist.json` est **gelée** (26 tables, 2 vues, 0 séquence au
  2026-10-19) et ne peut que **rétrécir** (lot A du plan de droits). Y ajouter une entrée exige un besoin
  prouvé, écrit et relu.
- `alter default privileges` n'est **pas** un substitut : son efficacité n'est pas démontrée sur cette pile.

## Limites assumées

Présence textuelle seulement pour la couche statique (un `REVOKE` qui nomme `anon` mais vise le mauvais
objet n'est pas détecté ; c'est la couche vivante qui fait foi). Droits de **colonne** non couverts.
Objets créés hors migration (console, Studio) non couverts : ils sont vus par la couche vivante.

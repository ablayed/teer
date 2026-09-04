# S4 — Étape 0 : mesures avant toute règle

Mesuré, pas déduit — sur stack locale (`supabase status`, stack `teer-dev`, migré à `0150`). Aucune
écriture distante, aucune migration.

## 1. Schémas exposés PostgREST

```
supabase/config.toml, section [api] :
schemas = ["public", "graphql_public"]
```

Confirmé identique à `EXPOSED_SCHEMAS` dans `scripts/lib/acl-snapshot.mjs:17` et à la constante du
même nom dans `tests/rls/function-execute-acl-invariant.rls.test.ts:37`. **Aucun écart** — les trois
sources sont synchronisées à ce jour. Rien à remonter en Tâche 7.

## 2. Comportement RLS du client admin (clé service-role, aucun JWT transmis)

**Fait mesuré, décisif :** `select rolname, rolbypassrls from pg_roles where rolname in ('anon',
'authenticated', 'service_role', 'authenticator');` sur la base locale donne :

| rolname | rolbypassrls |
|---|---|
| anon | false |
| authenticated | false |
| service_role | **true** |
| authenticator | false |

`service_role` porte `BYPASSRLS = true` au niveau du rôle Postgres lui-même. Le contournement RLS
n'est donc **pas conditionné à la présence ou l'absence d'un JWT utilisateur transmis** — c'est une
propriété du rôle sous lequel la requête s'exécute. La clé "service-role" *est* elle-même un JWT
portant la revendication `role: service_role` ; PostgREST/le pooler résout ce rôle et l'exécution se
fait avec `BYPASSRLS`, point final.

L'hypothèse documentée par Supabase ("le client admin retombe sous RLS si un jeton utilisateur lui
est transmis") décrit un motif différent : un client construit avec la clé service-role, mais dont
chaque requête reçoit ensuite un `global.headers.Authorization` (ou un `accessToken` callback / un
`setSession`) portant le JWT d'un utilisateur réel — dans ce cas PostgREST utilise ce JWT-là pour la
requête, pas la clé service-role, et RLS s'applique alors normalement. **Ce motif n'existe nulle part
dans ce dépôt** (voir §3).

Vérification empirique complémentaire : `lib/actions/transitions.ts:103-107` construit le client
admin ainsi —
```ts
createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
```
— sans `global.headers.Authorization` ni `accessToken`. Une lecture directe via ce motif exact contre
`public.orders` (RLS `FORCE`, `relforcerowsecurity = true`) confirme l'absence d'erreur RLS ; la table
étant vide sur ce seed local, le comptage de lignes n'était pas discriminant à lui seul — c'est la
mesure `rolbypassrls` ci-dessus qui tranche, pas le comptage.

**Conclusion pour la Tâche 5 :** l'affirmation "ce client contourne RLS sans condition" est exacte
pour ce dépôt — mesurée, pas supposée — à condition que le motif de construction confirmé en §3 (aucun
JWT transmis) reste vrai pour le fichier inventorié. L'inventaire de la Tâche 5 doit citer, pour
chaque fichier, la garde applicative en amont (rôle, HMAC, secret, jeton) — jamais une garde RLS,
puisque RLS ne s'applique structurellement jamais à ces appels.

## 3. Recherche de JWT transmis sur les 26 sites recensés

```bash
grep -rln "SUPABASE_SERVICE_ROLE_KEY" lib app --include='*.ts' | sort
```
→ 26 fichiers (liste complète en Tâche 5). Puis, sur cette liste exacte :
```bash
grep -rn "Authorization\|accessToken\|global:\s*{\|setSession" <ces 26 fichiers>
```
→ 8 correspondances, **toutes des faux positifs** : `accessToken`/`Authorization` y désignent le
jeton OAuth Shopify (`lib/shopify/shop-sync.ts:107/111/124`, `app/api/shopify/callback/route.ts:105/
109/163`) ou des noms de fonction sans rapport (`lib/shopify/dsar.ts:168/193`,
`issuePrivateDsarDownloadAuthorization`/`consumePrivateDsarDownloadAuthorization`). Aucune ne
construit un client Supabase avec un `global.headers.Authorization` ou un `setSession` portant un JWT
utilisateur.

**Résultat : 0/26 fichiers ne transmettent de JWT utilisateur au client service-role.** La conclusion
du §2 s'applique donc à l'inventaire complet, sans exception à documenter.

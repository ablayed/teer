# S2-D — `transition_order` et `p_actor` : ACL production, reproduction, inventaire des appelants

## Verdict

**`FALSIFIABLE — P0`**

L'attribution d'une transition de commande (`order_state_transition.actor_user_id`, et par
ricochet tout `stock_movement`/`purchase_lot_line_allocation` posé par la même transition) est
falsifiable par tout utilisateur authentifié membre de la boutique, via un appel PostgREST direct
à `transition_order`, sans élévation de privilège et sans contourner aucune RLS. Reproduit et
prouvé sur stack locale fraîche (`teer-dev`, migration `0147`, tête locale = tête prod attestée).
La question posée par la mission n'est pas hypothétique : elle est vraie aujourd'hui, avec preuve
avant/après.

Ce n'est PAS une question d'autorisation (`orders_update`/RLS bornent correctement qui peut faire
la transition) — c'est une question de **qui le journal dit que c'est**.

---

## 1. ACL

### 1.a Production — `PREUVE DB PRODUCTION INDISPONIBLE — requêtes prêtes, à exécuter par le fondateur`

Aucune connexion à la base de production n'est disponible dans cet environnement (le seul outil
DB connecté, `mcp__postgres__query`, pointe sur `127.0.0.1:54322`, confirmé par
`select current_database(), inet_server_addr()` → `172.18.0.10:5432`, une adresse de conteneur
Docker local, pas une adresse de production). Aucun fichier d'environnement n'a été lu pour tenter
de trouver des identifiants de production.

Requêtes prêtes à exécuter par le fondateur contre la base liée :

```sql
-- ACL brute de transition_order (une seule signature attendue si 0147 est bien la tête)
select p.oid::regprocedure as signature, p.prosecdef as security_definer, p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'transition_order';

-- Droit EXECUTE effectif, par rôle
select
  has_function_privilege('anon', 'public.transition_order(uuid,uuid,text,text,text,text,text,text,integer,timestamptz,timestamptz,text,uuid,text[],boolean,boolean,boolean,timestamptz,timestamptz,boolean)', 'EXECUTE') as anon_exec,
  has_function_privilege('authenticated', 'public.transition_order(uuid,uuid,text,text,text,text,text,text,integer,timestamptz,timestamptz,text,uuid,text[],boolean,boolean,boolean,timestamptz,timestamptz,boolean)', 'EXECUTE') as authenticated_exec,
  has_function_privilege('service_role', 'public.transition_order(uuid,uuid,text,text,text,text,text,text,integer,timestamptz,timestamptz,text,uuid,text[],boolean,boolean,boolean,timestamptz,timestamptz,boolean)', 'EXECUTE') as service_role_exec;

-- Même mesure pour reassign_order_driver (pattern identique, cf. §4)
select
  has_function_privilege('anon', 'public.reassign_order_driver(uuid,uuid,uuid,text)', 'EXECUTE') as anon_exec,
  has_function_privilege('authenticated', 'public.reassign_order_driver(uuid,uuid,uuid,text)', 'EXECUTE') as authenticated_exec;
```

**Sans résultat rendu, ce point reste `PREUVE DB PRODUCTION INDISPONIBLE`.** Rien dans ce rapport
n'affirme une valeur de production non mesurée.

### 1.b Local (rejeu, mesuré directement)

Stack : conteneurs Docker `supabase_*_teer-dev`, migration locale confirmée à `0147`
(`supabase migration list --local`, colonne Local = 0147, identique à Remote d'après
`CLAUDE.md`). Une seule signature de `transition_order` existe (les overloads legacy 4/5-arg
mentionnés dans `CLAUDE.md` comme un risque historique n'existent plus dans ce schéma — cohérent
avec `0115_drop_orphan_transition_order_overloads.sql`).

Mesuré via `mcp__postgres__query` (connexion confirmée locale) :

| Fonction | `security` | `proacl` | `anon` EXECUTE | `authenticated` EXECUTE | `service_role` EXECUTE |
|---|---|---|---|---|---|
| `public.transition_order` (19 args) | invoker | `{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}` | **false** | **true** | true |
| `private.post_stock_movement` (12 args) | definer | `{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}` | false | **true** (grant présent — non exposé PostgREST car schéma `private` non exposé, mais accessible depuis toute fonction s'exécutant comme `authenticated`) | true |
| `public.post_stock_movement` (13 args) | definer | `{postgres=X/postgres,authenticated=X/postgres}` | false | true | **false** |

### 1.c Diff prod/local et conclusion

**Diff non mesurable** : §1.a n'a rendu aucun résultat de production. Impossible de comparer.
**Ce n'est pas classé comme une divergence** (silence ≠ divergence) — c'est classé
`PREUVE DB PRODUCTION INDISPONIBLE`.

Cependant, `anon` n'a PAS `EXECUTE` sur `transition_order` en local, et rien dans l'historique de
migrations (`0067_phase13_1_transition_order_revoke_anon.sql`, confirmé par grep, jamais
recréé/regrant à `anon` dans les migrations postérieures) ne suggère que cette révocation aurait
été défaite. Le risque décrit ci-dessous ne dépend PAS de l'ACL `anon` : `authenticated` suffit,
et cette RPC est nommément appelée par le code applicatif pour `authenticated` (tout membre
connecté). Donc que l'ACL de production soit identique ou plus stricte sur `anon` ne change rien
au verdict — la voie d'attaque est `authenticated`, qui doit structurellement avoir `EXECUTE` pour
que l'application fonctionne.

**Conclusion de section** : `RPC DIRECT EXPOSÉ à authenticated` (confirmé local ; ACL prod
présumée identique par cohérence de migration mais non mesurée — voir §1.a). Le verdict final ne
repose pas sur cette mesure non rendue : il repose sur la reproduction ci-dessous.

---

## 2. Reproduction

**Environnement : stack Supabase locale jetable (`teer-dev`, Docker), migration `0147`.** Aucune
opération de production. Deux comptes A et B créés via `admin.auth.admin.createUser` (service-role,
local uniquement), A propriétaire d'un compte marchand jetable, B un utilisateur totalement
étranger à ce compte (jamais ajouté à `merchant_member`). Une commande jetable créée directement en
base (service-role) dans l'état `EN_LIVRAISON` (`delivery_state = out_for_delivery`), avec un
livreur jetable rattaché à la boutique par défaut.

**Appel exact** : `clientA.rpc('transition_order', { p_order_id, p_actor: <id de B>,
p_delivery_state: 'delivered', p_cash_state: 'collected', p_payment_channel: 'ESPECES',
p_delivered_at: <now> })`, où `clientA` est un client `@supabase/supabase-js` créé avec la clé
`anon` locale puis authentifié par `auth.signInWithPassword` pour l'email de A (JWT de session
réel, canal PostgREST, aucun accès SQL direct, aucun service-role côté appelant).

**Résultat AVANT** (lu en service-role avant l'appel) :

```json
{
  "id": "1acc7f7c-d819-44b6-8e4d-a1d63632645c",
  "cod_status": "EN_LIVRAISON",
  "order_state": "open",
  "delivery_state": "out_for_delivery",
  "cash_state": "not_due"
}
```

**Appel** : `error: null`, `data: "LIVREE"` — la transition légale `livrer` (le cas le plus
révélateur : elle pose `cash_state = collected` et déclencherait normalement une allocation FIFO)
a été acceptée, exécutée par A, sans aucun refus.

**Résultat APRÈS** sur `order_state_transition` (lu en service-role) :

```json
{
  "id": "ca831595-0dc9-4ddb-9745-67e3c3b9ec31",
  "actor_user_id": "5c9184c6-c2b0-4008-b41c-b826d8c14ffd",
  "from_status": "EN_LIVRAISON",
  "to_status": "LIVREE",
  "created_at": "2026-08-30T13:13:45.087172+00:00"
}
```

- Acteur réel de la session PostgREST ayant fait l'appel (A) : `414d8b96-3a83-40bd-b6ce-e0744b3340c3`
- Acteur forgé transmis en paramètre (`p_actor` = B) : `5c9184c6-c2b0-4008-b41c-b826d8c14ffd`
- **`actor_user_id` enregistré = B, jamais A. Attribution forgée réussie : `true`.**

**Autres tables potentiellement attribuées par la même transition** : `stock_movement` (filtré sur
`transition_id` de la ligne ci-dessus) → **aucune ligne** ; `purchase_lot_line_allocation` (filtré
sur `order_id`) → **aucune ligne**. Ceci est un artefact du fixture minimal utilisé (la commande
jetable n'a ni `order_line` ni `purchase_lot_line` avec stock disponible, donc l'allocation FIFO et
le mouvement de stock associés à `livrer` ne se déclenchent pas dans ce scénario simplifié) — **ce
n'est pas une preuve que le mécanisme est sûr sur ces tables**. Le code source (§ preuve
ci-dessous) montre que le même `p_actor` non vérifié est transmis tel quel à
`p_created_by := p_actor` à chaque appel de `private.post_stock_movement` à l'intérieur de
`transition_order` (`supabase/migrations/0145_lotF1_finances_v2_socle.sql`, lignes 1102, 1118,
1138, 1164, 1225, 1258, 1274, 1305) — la voie d'attaque existe structurellement pour ces tables
aussi, elle n'a simplement pas été déclenchée par ce fixture précis. Classé `probable, mécanisme
partagé prouvé par lecture directe` plutôt que `prouvée par reproduction sur ces deux tables`.

**Cause exacte, localisée** : `supabase/migrations/0145_lotF1_finances_v2_socle.sql:602-851`, corps
de `public.transition_order` — `p_actor` (paramètre reçu tel quel de l'appelant) est écrit
directement dans `order_state_transition.actor_user_id` (ligne 837/847) sans jamais être confronté
à `auth.uid()`. Grep exhaustif de `auth.uid()` dans ce fichier : présent uniquement ligne 229 (une
autre fonction, `s1c2_pcd_access_controls`, sans rapport), ligne 1569 et 1638 (dans
`public.post_stock_movement`, le wrapper 13-args — **celui-ci EST protégé**, voir §4). Le chemin
`transition_order → private.post_stock_movement` contourne entièrement cette protection car il
appelle le cœur `private` directement, jamais le wrapper `public` qui porte la garde.

---

## 3. Inventaire des appelants

| Appelant | Chemin de code | Rôle effectif à l'exécution | `auth.uid()` renseigné ? |
|---|---|---|---|
| Server Action `transitionOrderAction` (et le chemin auto-transition dans `logCallAction`) | `lib/actions/orders.ts:1573`, `:1658`, `:1729` → `performTransitionForContext` (`lib/actions/transitions.ts:278`) | `authenticated`, via `authActionClient`/`requireRole` (`lib/actions/safe-action.ts`), client cookie-based (`createSupabaseServerClient`) | **Oui, toujours** — `actorUserId: ctx.user.id` (ligne 1575/1660/1731) est lu côté serveur depuis la session cookie vérifiée, jamais depuis une valeur soumise par le client. C'est le SEUL appelant de production identifié. |
| Tests RLS (`tests/rls/orders-dimensions.rls.test.ts`, `stock-atomicity.rls.test.ts`, `driver-shop-eligibility-gate.rls.test.ts`, `lot-f1-finances-v2-socle.rls.test.ts`, `lot-f2-purchase-lot-profitability.rls.test.ts`, `lot-f2bis-ad-spend-separation.rls.test.ts`, `customer-reliability-projection.rls.test.ts`, `finance-kpis-cash-collected-at.rls.test.ts`, `finance-delivered-count.rls.test.ts`, `product-bundle-cascade.rls.test.ts`, `workspace-store-function-derivation.rls.test.ts`) | Appellent `client.rpc('transition_order', { p_actor: userId, ... })` où `client` vient de `signIn(email)` (JWT réel via `auth.signInWithPassword`) | `authenticated`, session réelle | **Oui, disponible** (le client est authentifié), mais **le test passe `p_actor` explicitement égal à l'id de l'utilisateur connecté** — jamais testé avec un `p_actor` divergent. C'est exactement le trou que cette mission ferme : aucun test n'existant ne couvre la divergence. |
| Tests E2E (`orders-transitions.spec.ts`, `drivers.spec.ts`, `finances.spec.ts`, etc.) | Passent par l'UI → Server Action → `performTransitionForContext` | `authenticated`, session navigateur réelle | Oui, via le même chemin que la production. |
| Cron de réconciliation (`app/api/cron/shopify-reconcile`) | Grep confirmé : **aucun appel à `transition_order`** (`grep -r transition_order app/` → 0 résultat) | N/A | N/A — ce chemin écrit l'état des commandes par upsert direct (hors state machine), pas par la RPC. Hors périmètre de cette mission (S2-D porte sur `transition_order`), mais noté : `inconnu` si ce chemin pose ses propres écritures attribuées ailleurs — non vérifié ici. |
| Webhooks Shopify (`lib/shopify/webhook-core.ts` et alentours) | Grep confirmé : **aucun appel à `transition_order`** | N/A | N/A |
| Scripts (`scripts/*.mjs`) | Grep confirmé : **aucun appel à `transition_order`** | N/A | N/A |

**Constat central** : en production, il n'existe qu'un seul appelant applicatif, et il renseigne
toujours `p_actor` depuis une session serveur vérifiée — **le défaut n'est exploitable par aucun
chemin applicatif existant**, seulement par un appel PostgREST forgé hors application (Postman,
script, extension navigateur, ou tout futur code qui accepterait un `actorUserId` venant du
client sans le confronter à la session). C'est précisément le motif que `CLAUDE.md` documente pour
l'incident 0134/0135 : un identifiant reçu du client (ou, ici, transmissible tel quel), jamais
confronté au parent autoritaire (`auth.uid()`), transmis à une opération qui en dérive
l'attribution.

---

## 4. Périmètre du motif

Autres fonctions SQL publiques recevant un identifiant d'acteur en paramètre plutôt que de le
dériver de `auth.uid()` (noms et chemins seulement, non auditées) :

- `public.reassign_order_driver(p_order_id uuid, p_actor uuid, p_new_driver uuid, p_note text)` —
  `supabase/migrations/0139_driver_shop_eligibility_gate.sql:120` (dernière définition complète).
  Grep confirmé : aucun `auth.uid()` dans cette fonction. Appelé par
  `lib/actions/orders.ts:2278` (`performReassignDriverForContext`, `p_actor: actorUserId` où
  `actorUserId` vient de `ctx.user.id` côté Server Action — même situation que `transition_order` :
  sûr par l'unique appelant applicatif, falsifiable par appel direct).
- `public.receive_purchase_lot(..., p_actor_id uuid, ...)` —
  `supabase/migrations/0136_post_stock_movement_private_schema.sql:1213`. Non auditée plus avant.
- **Contre-exemple notable, à ne pas confondre avec le motif** : `public.post_stock_movement`
  (13-args, `supabase/migrations/0136_post_stock_movement_private_schema.sql:350`) reçoit bien un
  `p_created_by uuid`, mais **le corrige lui-même** : `v_actor := auth.uid();` puis
  `if p_created_by is not null and p_created_by <> v_actor then raise exception` (lignes 369, 385).
  C'est la garde correcte, déjà en place ailleurs dans le même fichier — ce qui rend d'autant plus
  visible son absence dans `transition_order`/`reassign_order_driver`/`receive_purchase_lot`.

---

## 5. Coût estimé de la fermeture

- **`lib/actions/orders.ts` (Server Actions, seul appelant applicatif de `transition_order` et
  `reassign_order_driver`)** : coût nul à faible — `ctx.user.id` est déjà systématiquement égal à
  ce que `auth.uid()` verrait côté SQL (même session). Dériver l'acteur en SQL et ignorer/déprécier
  `p_actor` ne changerait aucun comportement observable pour ce chemin.
- **Suite de tests RLS (10 fichiers listés en §3)** : coût faible — chaque appel passe déjà par un
  client authentifié (`signIn(email)`) et fournit `p_actor` égal à l'utilisateur connecté ; retirer
  le paramètre ou le rendre ignoré ne casse aucune assertion existante (aucun test ne vérifie
  actuellement qu'un `p_actor` divergent est accepté — c'est le trou, pas une dépendance).
- **Suite E2E** : coût nul — passe uniquement par l'UI/Server Actions, jamais d'appel RPC direct.
- **Appelant sans session utilisateur** : **aucun identifié** pour `transition_order` (cron,
  webhooks, scripts : zéro occurrence, cf. §3). Le risque documenté dans la mission (« un correctif
  qui casse le cron nocturne ») **ne s'applique pas à cette fonction précise** — il resterait
  pertinent si un futur appelant service-role apparaissait sans session, auquel cas une dérivation
  stricte par `auth.uid()` casserait ce chemin (`auth.uid()` est NULL sous `service_role`) ; non
  observé aujourd'hui, marqué `inconnu` pour l'avenir plutôt que garanti.

---

## Restrictions respectées

Aucun correctif, migration, garde ou test committé. Aucune écriture de production (aucune
connexion de production n'a même été établie). Aucun fichier d'environnement lu. Aucune extension
vers UX/Tableau/`UX-COD-01`. Le script de reproduction Node (`s2d-repro.mjs`) a été exécuté depuis
la racine du dépôt (pour la résolution de `node_modules`) puis **supprimé immédiatement après
exécution** — jamais commité, confirmé par `git status --short` avant et après. Toutes les données
créées (2 utilisateurs Auth, 1 compte marchand, 1 boutique par défaut auto-créée, 1 livreur, 1
commande, 1 ligne `order_state_transition`) ont été détruites par le script lui-même en fin
d'exécution (bloc `cleanup()`, exécuté même en cas d'échec).

---

## SHA, commandes, diff

- SHA initial : `e3f5eb43c45bd8d4b17ff2466e9aca88da538d69`
- SHA final : `e3f5eb43c45bd8d4b17ff2466e9aca88da538d69` (inchangé)

Commandes exécutées (dans l'ordre logique, horodatage session du 2026-08-30) :

```
git rev-parse HEAD
git status --short
pnpm exec supabase status                      # (a d'abord échoué : Docker Desktop arrêté)
docker ps / docker version                     # confirmation Docker arrêté
(lancement de Docker Desktop, attente readiness)
docker ps                                      # confirmation stack teer-dev déjà présente (conteneurs existants, 14h)
pnpm exec supabase migration list --local      # confirmation tête locale = 0147
pnpm exec supabase status                      # récupération URL/clés locales (aucun fichier .env lu)
pnpm exec supabase status -o env               # idem, format clé=valeur (toujours local uniquement)
mcp__postgres__query: select current_database(), inet_server_addr(), inet_server_port();
mcp__postgres__query: select ... pg_proc.proacl / has_function_privilege ...  (transition_order, private.post_stock_movement, public.post_stock_movement)
grep/Read sur lib/actions/transitions.ts, lib/actions/orders.ts, supabase/migrations/{0116,0131,0136,0139,0145,0147}*.sql
mcp__postgres__query: select conname, pg_get_constraintdef(...) from pg_constraint ... orders_order_state_check
(copie temporaire de s2d-repro.mjs à la racine du repo, exécution `node ./s2d-repro.mjs`, suppression immédiate)
git status --short   # confirmation : seul docs/phaseU/ non suivi après suppression du script
```

Aucune commande destructive n'a touché le stack local persistant `teer-dev` au-delà des lignes
créées puis supprimées par le script de reproduction (pas de `db reset`, pas de `supabase stop`,
puisque ce stack préexistait à cette session et sert au développement courant).

**Diff attendu confirmé** : uniquement `docs/phaseU/S2-D-ACTOR-ATTRIBUTION.md` (nouveau fichier,
non suivi). `git status --short` avant et après cette mission montre exactement
`?? docs/phaseU/` (répertoire contenant ce fichier et le rapport `U0-D1`, produit par un lot
antérieur, non modifié par S2-D).

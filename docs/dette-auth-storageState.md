# Dette E2E - auth `storageState`

> Statut : hors scope du lot `infra/e2e-build-prod`.
> Objet : refactor de fixtures E2E pour utiliser `storageState` sans perdre la couverture
> multi-tenant / multi-role / invitation.

## Pourquoi ce n'est pas dans le lot build-prod

Les helpers `signIn` restants ne sont pas une simple duplication mecanique. Les specs E2E creent des
utilisateurs distincts a la volee, avec des roles et tenants differents, pour verifier :

- l'isolation tenant ;
- les droits `owner`, `manager`, `agent` ;
- les invitations et parcours sans organisation ;
- les scenarios ou un test passe volontairement d'un compte a un autre.

Un `storageState` global par projet casserait cette couverture en reutilisant une seule session. Le
remplacer sans refactor de fixtures masquerait donc des garanties produit reelles.

## Chantier a traiter separement

Objectif : reduire le cout de login E2E sans affaiblir la couverture.

Pistes a instruire :

1. Separarer les specs qui peuvent utiliser des comptes stables de celles qui doivent creer des
   comptes uniques.
2. Creer un modele de fixtures explicite : tenant A owner, tenant A manager, tenant A agent, tenant B
   owner, invite sans org, etc.
3. Sauver un `storageState` par identite stable, pas un etat global unique.
4. Inspecter les fichiers `storageState` reels avant decision WebKit/http :
   - cookies Supabase `sb-*-auth-token` ;
   - champ `secure` ;
   - comportement WebKit sur `http://localhost`.
5. Prevoir un refresh/TTL : un JWT Supabase expire ne doit pas rendre les specs flaky.
6. Garder des helpers de creation dynamique pour les tests qui prouvent l'isolation ou l'invitation.

## Critere de sortie

- Aucun test multi-tenant ou multi-role ne perd son assertion d'isolation.
- Les comptes stables sont documentes et seedes de facon deterministe.
- `iphone-14` est valide seul apres tout changement de cookie/session.
- Le gain de temps est mesure sur CI, pas suppose.

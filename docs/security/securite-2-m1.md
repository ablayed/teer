# M1 — matrice locale d'autorisation

**Nouveau constat intertenant confirmé : SEC-A-002, haute — catégorie de dépenses étrangère acceptée, libellé privé exposé au rapport et suppression légitime de la catégorie B bloquée.** Voir [diagnostic et preuves](./securite-2-sec-a-002.md). Cette extension compte cinq cas : un conforme et quatre violations. Total identifié/exécuté M1 étendu : **1 051 / 1 051**, dont **1 047 conformes et quatre violations**. La CI verte de la matrice initiale ne détectait pas ce mélange de tenant parent/enfant. Aucun correctif effectué.

Date : 11 novembre 2026. Base applicative : `428af3b` (S0 et T1 fusionnés). Aucune correction applicative, migration ni opération distante. Verdict du lot étendu : **VULNERABLE**, pas une attestation de sécurité globale.

## Problème et méthode

Une garde qui refuse toutes les requêtes ne démontre pas la bonne autorisation. Les nouveaux tests autonomes exécutent donc des lectures, listes, créations et modifications autorisées et interdites avec deux comptes marchands indépendants, leurs owners, managers et agents, deux utilisateurs Auth liés à des livreurs, un membre retiré après connexion et un anonyme. Le membre retiré conserve une session Auth valide : le refus doit venir de son absence d'appartenance actuelle.

Le modèle réel ne possède que trois TeamRole : owner, manager, agent. Un livreur lié par driver.user_id n'est pas automatiquement membre marchand. Les tests vérifient cette frontière ; ils ne prétendent pas tester un portail livreur inexistant. Les agents peuvent lire les commandes de leur boutique ; aucun filtre d'affectation imaginaire n'est ajouté. La page Finances est réservée à l'owner ; managers et agents ont des contrôles positifs sur leurs autres opérations autorisées.

Supabase local uniquement, données synthétiques, JWT individuels réels. Le client privilégié sert uniquement à créer, observer et supprimer les fixtures. Les requêtes évaluées utilisent les clients utilisateurs. Next tourne avec `next start`, le build applicatif réel et les identifiants Server Action du manifeste local ; aucune garde d'autorisation n'est simulée. Le fournisseur Groq est une doublure SSE locale, tout fetch extérieur est bloqué. Aucun secret, cookie, mot de passe ou contenu client n'est enregistré.

## Cas applicables identifiés et exécutés

| Transport | Cas | Portée |
|---|---:|---|
| PostgREST/RLS et RPC | 640 | 10 acteurs × 2 tenants × 8 familles × 4 opérations ; commandes, clients, livreurs, cash, finances, stock, exports, conversations IA |
| Route Handlers | 100 | commandes GET/POST, chat IA authentifié, autorisation et téléchargement réel d'export DSAR |
| Server Actions HTTP | 260 | 13 actions × 10 acteurs × 2 tenants : commandes, clients, livreurs, équipe, stock, cash, finance et conversations/messages IA |
| RSC | 40 | Produits et Finances, consentement courant et onboarding synthétiques ; réponses réelles après redirection locale `_rsc` de Next |
| Grants de colonne | 6 | agents A/B et membre retiré, coûts produit des tenants A/B |
| **Total** | **1 046** | Le catalogue et chaque résultat sont conservés dans `m1-cases.json` |

Les tests négatifs observent l'absence du marqueur ciblé et, pour les écritures, l'état SQL après l'appel. Une erreur de validation de fixture ne vaut pas un refus d'autorisation. Les positifs exigent la donnée ou l'effet métier attendu. Les payloads RSC agents doivent exclure les sentinelles de coûts. Les exports négatifs réutilisent également un jeton valide mais lié à un autre acteur, pour ne pas tester seulement un jeton mal formé.

Couverture de **ce catalogue borné** = cas exécutés / 1 046. Ce dénominateur ne représente pas toutes les variantes du dépôt. Le JSON indique aussi si le comportement observé est seulement fail-closed. Les tests IA RLS et red-team existants sont exécutés séparément : ils complètent le catalogue, sans gonfler artificiellement son pourcentage.

## Résultats, limites et diagnostic

La matrice élargie a exécuté 1 046 cas, tous conformes aux observations attendues, aucun ignoré. **Vingt refus HTTP retournent 503** : commandes sur boutique étrangère (12), autorisation d'export étrangère (4), téléchargement étranger (4). Aucune donnée cible n'a été observée, mais ces cas restent **NEEDS INVESTIGATION** : l'erreur serveur peut masquer une garde incomplète et ne satisfait pas à elle seule le contrat de refus métier.

Les premières tentatives conservées dans les preuves locales ont exposé des erreurs de harnais : l'action de liste d'équipe exige `{}` ; les requêtes RSC Next sans `_rsc` passent par une redirection 307 locale. Le harnais envoie désormais le schéma réel et suit uniquement cette redirection sur la même origine. Aucune assertion d'accès autorisé/interdit, aucun test préexistant, timeout ou seuil n'a été affaibli. Aucun échec n'est supprimé des preuves locales.

Limites : cette matrice ne couvre pas tous les Server Actions, toutes les transitions COD, les courses financières, les exports PDF/CSV, tous les outils IA via une vraie décision de modèle, les autres intégrations ni la configuration distante. Les scénarios à deux tenants ne remplacent pas ceux à plusieurs boutiques dans un même tenant. Le fournisseur simulé vérifie le transport et l'authentification, pas la résistance d'un modèle réel aux injections. L'absence de violation observée ici ne clôt ni SEC-D-001 ni SEC-G-001.

## Exécution reproductible

Installer les dépendances verrouillées sans scripts, démarrer Supabase local avec la configuration du dépôt, construire en `VERCEL_ENV=preview` avec les variables Supabase exclusivement locales, puis exécuter :

```powershell
$env:M1_RESULTS_PATH='docs/security/m1-cases.json'
node --test --test-concurrency=1 tests/security/m1-authorization-matrix.mjs
pnpm exec vitest run tests/rls/ia-assistant.rls.test.ts tests/unit/ia/red-team.test.ts
```

Après introduction de F2 (Redis fail-closed), exécuter la matrice avec son wrapper `node tests/security/f2-run-authorization-matrix.mjs`. Le harnais accepte uniquement un backend de fixture explicitement injecté par `M1_LOCAL_REDIS_URL` (127.0.0.1) et `M1_LOCAL_REDIS_TOKEN` ; il continue de supprimer toute configuration Upstash réelle héritée. Aucune assertion d'autorisation ne change. Sans F2 et sans fixture, la commande autonome historique reste applicable. L'exécution combinée utilise le vrai build F2 et le catalogue M1, sans merge de branche.

Les clés de test local sont injectées en mémoire, jamais copiées dans un fichier. Ne pas sourcer `.env*`. Le script refuse une origine Supabase autre que `127.0.0.1:54321`. Les nouveaux tests autonomes ne sont pas encore câblés dans la CI générale : une CI verte ne signifie pas leur exécution. Les validations standard locales de cette base (typecheck, lint, unité, build, 812 tests RLS, ACL et inventaire service-role) sont conservées dans les preuves de l'audit.

## Suite proposée et approbation

PR de tests et documentation uniquement, **aucune fusion autorisée** pour ce lot. Faire relire les attentes métier, diagnostiquer les 20 erreurs 503, compléter les transports/variantes exclus et intégrer le harnais à une CI isolée avec fixtures locales. Toute future correction doit préserver les positifs et faire échouer sa régression négative avant correction. Risque métier résiduel : une faille hors du catalogue demeure possible ; verdict global **NO-GO** tant que les failles confirmées et les contrôles essentiels ouverts ne sont pas résolus ou explicitement acceptés.

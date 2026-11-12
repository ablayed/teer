# SEC-A-002 — correction préparée, migration non autorisée à distance

## Problème et cause

Gravité haute, catégorie A/B/F (autorisation et intégrité financière). Un owner A connaissant l'UUID d'une catégorie B pouvait créer/modifier une dépense A liée à B. L'action privilégiée vérifiait seulement si la catégorie était ADS : une catégorie absente du tenant était assimilée à non-ADS. La RLS expense contrôlait l'owner de la ligne, pas le parent référencé ; la FK simple ne portait que category_id. Le rapport financier privilégié relisait les catégories par ID sans scope. Une référence étrangère pouvait aussi bloquer la suppression légitime de la catégorie B.

Preuve antérieure conservée : source `security-audit-proofs/tests/rls/security-audit-expense-category.rls.test.ts`, journal `evidence/s2-expense-category-proof-final.txt`, quatre violations et un positif le 11 novembre. Les SHA-256 source/journal sont respectivement `D8D75CF12016D7DD5EADE1975EFF401CBD9C108C10D591A671C97E46374BD748` et `90993913634DDF919E7EFB2AA5860FBD7C6529FAFB2919178C51C2EC20159849`. Pas de nouvelle reproduction sur l'ancienne version, aucun test distant. La nouvelle suite conserve les assertions de ces quatre violations et ajoute des contrôles positifs et l'immuabilité référentielle du tenant parent.

## Inventaire et périmètre

`relational-fk-inventory.json` recense les 119 FK public→public du catalogue local avant migration. `relational-reference-register.md` décrit les 73 références dont les deux côtés portent une scope, avec FK, triggers candidats et WITH CHECK. Les alias tenant_id et merchant_account_id sont rapprochés dans le comptage. Les références vers les racines tenant/Auth et celles sans scope dupliquée restent dans le JSON intégral. Les corps des triggers/policies sont dans relational-controls.json ; aucune donnée métier n'est incluse.

Il s'agit d'un inventaire structurel complet des FK de ce catalogue, **pas d'une revue achevée de chaque appelant TS/RPC ni d'une preuve de sécurité de tous les liens**. Les contrôles manquants ou insuffisamment établis restent explicitement NEEDS INVESTIGATION, notamment plusieurs liens commandes/lignes/adresses, cash/livreurs et traces d'intégration. Les scopes shop nullables demandent une interprétation métier ; ne pas imposer une égalité de boutique sur les objets réellement partagés. Les 73 lignes ne sont donc pas qualifiées VERIFIED SECURE.

L'inventaire exhaustif ne justifie pas une migration générale non testée sur les 73 références. Le présent correctif ferme la relation financière dont la violation est établie. Les liens équivalents non couverts exigent des lots suivants, après cartographie de leurs RPC, privilèges et effets de suppression. Aucun nouveau chemin d'attaque n'est exécuté pour les confirmer dans cette étape défensive.

## Comptage avant toute opération de production

Le SQL court `count-sec-a-002.sql` et le SQL d'inventaire `count-inconsistent-business-references.sql` sont prêts à exécuter humainement, **lecture seule et comptes uniquement**. Aucune exécution de production ici. Une visibilité complète des lignes est indispensable : une lecture RLS filtrée ne prouve pas zéro incohérence. Si un compte est positif : arrêt, revue sécurisée des données financières par le porteur, aucune suppression, réattribution ou correction automatique. Un timeout ne signifie pas zéro.

Un premier comptage local sur l'ancienne base synthétique réutilisée a montré des différences de boutique sur certaines fixtures commandes/stock ; ces comptes sont conservés dans relational-count-local.txt. Ils ne décrivent aucune donnée de production et ne sont pas une nouvelle preuve d'exploitation. Les migrations et tests se font ensuite sur une nouvelle base locale via db reset, pas par réparation silencieuse de données financières.

## Correction

- Actions : charger la catégorie par ID **et tenant de session**, refuser absence/erreur avant toute mutation ; conserver les règles ADS, y compris l'édition d'une dépense historique déjà ADS. Aucun rôle supplémentaire autorisé.
- Rapport : filtrer la catégorie par tenant ; une catégorie absente ou un échec de lecture provoque data_error, jamais une fuite de libellé ni un total silencieusement recalculé. Les données historiques incohérentes peuvent rendre un rapport indisponible jusqu'à revue humaine : risque UX explicite.
- SQL : migration unique 0171, commit distinct. FK `(category_id, merchant_account_id)` vers une paire unique `(id, merchant_account_id)` ; ON DELETE RESTRICT conservé. Ce contrôle transactionnel couvre concurrence, accès directs et rôles BYPASSRLS, et protège aussi le changement de tenant du parent. Il ne dépend pas d'un trigger ad hoc ou de la visibilité RLS. Pas de nouvelle fonction ni de GRANT.
- Précondition : transaction explicite, verrou limité à cinq secondes, délai de statement 30 s, comptage puis DDL ; erreur si incohérence, rollback sans nettoyage. Index unique supplémentaire et verrous : à planifier dans une fenêtre adaptée après le comptage humain. Ne pas supprimer la FK simple hors de cette transaction.

La première exécution locale de la migration a révélé que la CLI ne fournissait pas de transaction pour LOCK TABLE : arrêt SQLSTATE 25P01 avant tout DDL. La migration est corrigée par BEGIN/COMMIT explicites, aucun test ou timeout de suite modifié ; le journal initial reste conservé. Les types Supabase ne changent que pour décrire cette relation composite, sans `db:types --linked` ni accès distant.

## Validation et arrêt

Sanity locale complète sur la base initiale 428af3b : typecheck, lint, build et invariants ACL/service-role verts ; 2 060 unités passantes et trois ignorées préexistantes ; **819 RLS passantes, aucune ignorée, dont les sept cas du nouveau fichier**. Les quatre violations historiques sont vertes avec la FK et les gardes applicatifs ; création, édition/rapport et suppression légitimes restent autorisées, changement du tenant parent refusé. Les logs sont `security-audit-proofs/docs/security/evidence/s3-a002-verified-*`. Une tentative intermédiaire de RLS avait omis la valeur synthétique RESEND_API_KEY au chargement des modules : journal rouge conservé, environnement corrigé et nouvelle base locale complète, aucun test/seuil modifié. Aucun test existant modifié. Une CI verte après rebase ne vaut ni application de la migration en production ni validation des données existantes.

**PR préparée mais non fusionnée ; aucun db push. SEC-A-002 reste OUVERTE tant que la cause racine n'est pas appliquée et vérifiée dans l'environnement concerné.** Après compte nul et revue, le porteur décidera du db push et de la séquence de mise en service. Ne pas fusionner l'application comme si la barrière SQL était déjà effective. Retour arrière : revue nécessaire avant retrait de la FK composite ; remettre d'abord la FK simple si indispensable, conserver les données et le filtrage applicatif. Retirer la barrière réouvre le risque et ne constitue pas un rollback de données.

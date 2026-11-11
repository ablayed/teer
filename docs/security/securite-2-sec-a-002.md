# SEC-A-002 — dépenses : référence de catégorie intertenant

**Haute conditionnelle, catégories A/B/E ; VULNERABLE, confirmé localement, non corrigé.** Confiance élevée sur les effets ; connaissance initiale d'un UUID étranger nécessaire et non démontrée en production. Aucun accès anonyme ni extraction de commandes/clients démontré.

## Chemin complet et cause racine

Un owner A authentifié peut saisir `categoryId` B dans `createExpenseAction` (`lib/actions/expenses.ts:80–113`) ou `updateExpenseAction` (`:115–151`). `requireRole` vérifie réellement getUser et l'appartenance owner A ; le tenant de la dépense vient de cette session. Cependant, `isAdsCategory` (`:35–47`) filtre la recherche de catégorie sur A et renvoie false si la catégorie B n'est pas trouvée. L'action continue puis utilise le client privilégié pour insérer/modifier la dépense A avec l'UUID B sans vérifier sa propriété.

La relation SQL `expense.category_id → expense_category.id` (`supabase/migrations/0035_phase6_finance.sql:383`) n'inclut pas le tenant. Les policies expense INSERT/UPDATE contrôlent le rôle du tenant de la dépense, pas celui de sa catégorie (`:413` et suivantes). Le client owner A peut aussi créer la référence directement par PostgREST : ajouter seulement une garde applicative ne corrigerait pas ce second chemin.

Puis `getFinanceReportAction` (`lib/actions/profit.ts:23–43`) utilise `fetchFinanceReport` avec le tenant A issu de la session. Le builder lit les dépenses A puis leurs catégories par `.in('id', categoryIds)` via service_role sans filtre de tenant (`lib/finance/report-data.ts:120–127`), et sérialise code/libellé B dans le rapport A (`:207–210`). La lecture directe de la catégorie B par le JWT A est pourtant refusée par RLS. La FK `ON DELETE RESTRICT` permet en outre à la dépense A d'empêcher B de supprimer sa propre catégorie, sans dépense B.

## Préconditions et preuve synthétique

Owner A, deux tenants indépendants, connaissance de l'UUID d'une catégorie B. UUID non énuméré ni extrait d'un environnement distant. Les deux owners créent leurs propres catégories sous leurs JWT réels. La catégorie B reçoit un marqueur privé aléatoire synthétique. Aucun identifiant, libellé réel, cookie ou credential dans les preuves publiées.

Le test local appelle les vraies fonctions Server Action et leur middleware d'autorisation avec un client Supabase utilisateur authentifié réel. Seule la fabrique de client serveur est injectée avec ce client JWT ; getUser, lookup de rôle, requêtes SQL et lecture du rapport ne sont pas simulés. Revalidation Next et Sentry sont simulés. Ce test d'intégration n'est pas une nouvelle reproduction HTTP/cookie ; le transport HTTP et le middleware commun sont couverts séparément dans la matrice initiale. Tous les fetch non locaux sont refusés. Les fixtures et références sont supprimées après le test.

| Test | Attendu | Observé |
|---|---|---|
| Positif : créer dépense A avec catégorie A | accepté | accepté, vert |
| Négatif : créer dépense A avec catégorie B puis rapport A | refus et aucun libellé B | accepté, référence SQL créée et libellé B présent ; rouge |
| Négatif : INSERT PostgREST A avec catégorie B | refus SQL | accepté ; rouge |
| Négatif : UPDATE action d'une dépense A vers catégorie B | refus, catégorie A conservée | accepté, référence B ; rouge |
| Positif : B supprime sa catégorie sans dépense B | accepté | refus FK 23503 à cause des dépenses A ; rouge |

**Cinq cas exécutés : un passant, quatre rouges.** Source locale : `security-audit-proofs/tests/rls/security-audit-expense-category.rls.test.ts`, SHA-256 `D8D75CF12016D7DD5EADE1975EFF401CBD9C108C10D591A671C97E46374BD748`. Journal : `docs/security/evidence/s2-expense-category-proof-final.txt`, SHA-256 `90993913634DDF919E7EFB2AA5860FBD7C6529FAFB2919178C51C2EC20159849`, cinq cas, 2,07 s. Les exécutions préliminaires sont également conservées. Le test rouge n'est pas commité ni masqué par une modification de baseline, conformément à Never commit red.

Les fichiers applicatifs affectés et safe-action sont identiques entre la base des preuves `4db58e2` et main `428af3b` (diff vérifié nul). Les dépendances du worktree des preuves incluent Next 16.4.6 ; la base SQL locale a été reconstruite depuis les migrations actuelles lors du diagnostic S3. Aucun état de production n'est inféré.

Reproduction, uniquement dans le worktree des preuves avec Supabase local et les clés locales injectées en mémoire, sans lire `.env*` :

```powershell
pnpm exec vitest run tests/rls/security-audit-expense-category.rls.test.ts
```

Les données ne sont pas préinsérées : le test crée deux owners, deux catégories et une petite quantité de dépenses synthétiques. Après correction, les trois négatifs doivent refuser sans référence étrangère ni libellé privé ; les deux positifs doivent passer, notamment la suppression B. Le journal rouge n'est pas un résultat de la suite CI existante.

## Correction proposée et dépendances

1. Gardes applicatives création/modification : rechercher la catégorie dans le tenant authentifié et refuser explicitement une absence ; conserver le comportement légitime ADS historique et les dépenses des boutiques par défaut. Ne pas convertir « introuvable » en catégorie autorisée.
2. Défense de lecture : filtrer les catégories du rapport privilégié par tenant authentifié, même après réparation des relations. Vérifier le même builder dans les exports PDF/CSV et dans l'IA ; aucune exposition de ces transports n'est prétendue reproduite ici.
3. Invariant SQL commun : imposer que tenant de dépense et tenant de catégorie correspondent, y compris les écritures JWT et service_role. Étudier FK composite avec clé unique parente appropriée ou contrainte équivalente, puis tests positifs/négatifs. **Ne pas préparer une révocation massive pour compenser ce défaut de relation.**
4. Avant migration, inventorier les dépendances, les catégories et références existantes avec comptes seuls ; toute réparation de dépenses comptables exige décision explicite et conservation de la trace, jamais suppression automatique. Au plus une migration dans le lot correctif proposé ; déploiement progressif et rollback qui ne réouvre pas le chemin étranger.

Sonde en lecture seule à faire exécuter par le porteur sur l'environnement voulu :

```sql
begin transaction read only;
select count(*) as cross_tenant_expense_category_references
from public.expense e
join public.expense_category c on c.id = e.category_id
where e.merchant_account_id <> c.merchant_account_id;
rollback;
```

Aucune migration, correction applicative ou sonde distante effectuée. Priorité haute selon le mandat pour les violations intertenant : métadonnées privées et intégrité/disponibilité des catégories B. L'impact reste borné à ce qui est démontré ; ni montants B, ni clients B, ni suppression d'écritures financières B n'ont été obtenus. **NO-GO**, lot correctif à faire approuver avant changement de schéma ou de production.

-- À exécuter humainement en production, avec visibilité complète, avant toute migration.
-- Lecture seule, compte uniquement. Aucun identifiant, libellé ou montant retourné.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT count(*) AS inconsistent_expense_category_count
FROM public.expense e
LEFT JOIN public.expense_category c ON c.id = e.category_id
WHERE c.id IS NULL
   OR c.merchant_account_id IS DISTINCT FROM e.merchant_account_id;
ROLLBACK;

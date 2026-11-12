# M1 — classification corrigée et diagnostic des 503

12 novembre 2026. Aucune modification applicative ou SQL. PR #315 à relire, pas de fusion autorisée par le dernier addendum.

## Cause du défaut de compte rendu

Le harnais déduisait `observedAllowed=false` d'une réponse sans marqueur, puis `passed=true` de son égalité avec le refus attendu. Un 503 pouvait ainsi être compté comme contrôle d'autorisation validé. L'ancien JSON de 1 046 observations reste une preuve de l'observation, pas une certification de 1 046 autorisations. Son ancien champ passed était trop large.

Le nouveau classificateur distingue AUTHORIZATION_CONFIRMED, DENIAL_CONFIRMED, INDETERMINATE_PROCESSING_ERROR, INDETERMINATE_CONTRACT_EVIDENCE et VIOLATION_CONFIRMED. Un 5xx sans divulgation devient indéterminé ; un contenu interdit reste une violation même si son statut est 5xx. Les négatifs HTTP exigent un contrat de refus identifiable. Une simple absence de marqueur dans un 200 ne suffit plus. `passed=null` signifie contrôle non établi ; `observationPassed` distingue l'observation fonctionnelle du verdict d'autorisation. Le rapport compte séparément les classifications et la couverture exécutée/applicable. Aucun test initial, seuil ni timeout supprimé ou assoupli ; assertions de forme d'erreur et d'absence de contenu ajoutées.

## Les 20 réponses historiques 503

| Famille | Nombre | Chemin et cause statique vérifiés | Interprétation |
|---|---|---|---|
| Orders GET/POST, rôles actifs vers boutique étrangère, recherche vide | 12 | app/api/orders/search/route.ts → getOrdersPageData/lib/actions/orders.ts : RLS filtre les données, puis auditOrdersPageAccess → writePcdAccessAudit → log_pcd_access_event. Le garde SQL de 0125 rejette shop/tenant incompatibles par 42501 avant INSERT ; PcdAccessAuditError est rendu en 503 audit_unavailable. | Erreur de traitement, pas refus HTTP contractuel confirmé |
| DSAR autorisation, owner/manager vers boutique étrangère | 4 | Route DSAR → consumePcdQuota → consume_pcd_access_quota (0124) : pcd_quota_shop_forbidden/42501 avant compteur. Le wrapper transforme tout échec en quota_unavailable ; catch HTTP rend 503 avec reauthentication_required. | Erreur de traduction trompeuse, pas preuve de panne Redis ni d'authentification expirée |
| DSAR téléchargement, mêmes acteurs | 4 | Même garde de quota avant consommation de l'autorisation privée, même traduction 503. | Indéterminé au contrat HTTP ; ne pas certifier un refus normal |

Deux tests unitaires passent par les vrais wrappers avec une réponse SQL 42501 simulée ; ils documentent la conservation de cause audit et l'aplatissement quota. Les assertions HTTP vérifient l'enveloppe exacte et l'absence de données pour ces 503, sans les reclasser en refus confirmé. Le passage d'un test diagnostique ne rend pas le contrôle d'autorisation vérifié.

La correction applicative exige une décision séparée : vérifier l'accès à la boutique avant quota/audit, conserver une journalisation de refus cohérente et traduire permission vs indisponibilité sans masquer les pannes réelles. Elle touche l'ordre des contrôles et les journaux PCD, donc aucune modification métier dans cette PR de tests. Conserver les 503 jusqu'à une PR dédiée, pas modifier les seuils pour les faire disparaître.

## Limites

Les classifications prudentes peuvent laisser d'autres négatifs HTTP indéterminés si l'enveloppe ne prouve pas son contrat, même sans fuite observée. Les résultats recalculés seront enregistrés après exécution locale, et non copiés de l'ancien total passed. Les cas SEC-A-002 historiques restent ouverts et distincts ; le catalogue n'épuise pas toutes les références métier ni les variantes d'actions/outils IA.

## Résultats exécutés, 12 novembre

| Classification | Cas |
|---|---:|
| Accès autorisé confirmé | 232 |
| Refus selon contrat confirmé | 596 |
| Erreur de traitement indéterminée | 20 |
| Contrat de refus insuffisamment établi | 198 |
| Violation observée dans ce catalogue initial | 0 |
| Exécutés / applicables identifiés | 1 046 / 1 046 (100 % d'exécution) |
| Contrôles étayés / applicables | 828 / 1 046 (79,16 %, pas une note globale de sécurité) |

Les 198 autres indéterminés comprennent 178 Server Actions HTTP 200, 16 recherches commandes HTTP 200 et quatre RSC 200. Le handleServerError de lib/actions/safe-action.ts aplatit les exceptions d'autorisation comme les pannes en UNEXPECTED_ERROR : une réponse opaque et sans effet ne suffit pas à distinguer leurs causes. Certaines actions sans identifiant tenant opèrent sur le contexte propre de l'acteur ; l'absence d'effet sur un tenant B ne prouve pas qu'une opération explicitement ciblée B ait été refusée. Les recherches sans membre rendent un objet vide en 200 via getOrdersPageData, sans contrat HTTP de refus explicite. Les RSC concernés n'exposent pas le marqueur, mais leur 200 ne prouve pas son motif. Ces limites sont conservées dans le dénominateur, pas supprimées pour augmenter la couverture.

Les assertions d'effets attendus restent passantes, mais **218 contrôles ne sont pas validés**. Le nouveau JSON remplace le compteur global passé par des champs distincts ; l'ancien JSON est conservé dans les preuves locales et l'historique Git. Aucune correction du handler commun ou des endpoints n'est effectuée dans cette PR de tests. Ne pas fusionner #315 comme preuve complète d'autorisation.

Validation locale sur main avec F2 : typecheck/lint/build verts, 2 067 unités passantes (trois ignorées préexistantes), 812 RLS passantes, ACL/inventaire verts ; quatre tests Node du classificateur et les 1 046 observations passent avec Redis local réel et fournisseur SSE simulé. Journaux `security-audit-proofs/docs/security/evidence/s3-m1-*`. Les scripts HTTP autonomes ne sont pas exécutés automatiquement par la CI standard ; ses deux verts ne remplacent pas cette preuve locale ni les contrôles encore indéterminés.

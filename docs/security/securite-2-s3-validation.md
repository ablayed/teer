# S3 — politique d'incident et diagnostic RLS indépendant

Date : 11 novembre 2026. Base : `428af3b` ; aucun correctif F1, M1 ou F2 inclus. PR documentaire uniquement, **sans fusion autorisée**. Le brouillon opérationnel est [reponse-incidents.md](./reponse-incidents.md), en français, avec responsable et contact fournis par le porteur. Il couvre gravité, détection, confinement, rotation compatible, conservation des preuves, restauration isolée, communication et revue après incident. Il ne certifie ni conformité Shopify ni capacité de reprise effectivement exercée.

## Les 11 échecs historiques restent ouverts

Le journal `security-audit-proofs/docs/security/evidence/s3-clean-test-rls.txt` conserve la suite du 11 novembre à 16:18:43 : **11 échecs, 801 succès, 812 cas**. Les fichiers concernés sont `tests/rls/shopify-legacy-app-binding.integration.test.ts` et `tests/rls/shopify-webhook-replay.integration.test.ts`. Aucun test, timeout ou seuil n'a été modifié.

| Cas historique | Observation rouge |
|---|---|
| Legacy B positive, customers/data_request | auditCount 0 au lieu de 1 |
| Legacy B uninstalled, customers/data_request | délai 15 000 ms dépassé |
| Demande d'accès en panne puis reprise | délai 15 000 ms dépassé |
| Reprise rejouée sans écriture supplémentaire | délai 15 000 ms dépassé |
| Deux reprises concurrentes, un traitement | délai 15 000 ms dépassé |
| Panne après création de l'artefact | délai 15 000 ms dépassé |
| Sujet non repris app/uninstalled | délai 15 000 ms dépassé |
| Commande créée en panne puis reprise avec lignes | délai 15 000 ms dépassé |
| Charge déjà appliquée puis charge plus récente | délai 15 000 ms dépassé |
| 1 001 événements non éligibles et ancien éligible | retryable au lieu de done |
| Exécution morte, bail expiré et marge | retryable au lieu de done |

Une autre exécution historique `s3-test-rls.txt` avait 13 échecs WooCommerce ; ne pas la confondre avec ces 11 échecs Shopify. Au lot F2, la réutilisation d'une base ayant des connexions aux identités WooCommerce fixes a été observée (quatre collisions avant reset, zéro après), mais ce fait n'établit pas la cause des 11 échecs ci-dessus.

## Diagnostic exécuté ici

1. Nouveau worktree S3 actualisé vers main, dépendances verrouillées, aucun script d'installation, aucune lecture `.env*`.
2. Reset de **la seule base Supabase locale synthétique**, redémarrage de Kong, attente du 200 Auth ; aucune cible distante.
3. Sanity complète : typecheck, lint (six avertissements préexistants), 2 060 tests unitaires passants et trois ignorés préexistants, build, **812 tests RLS passants**, baseline ACL et inventaire service-role verts.
4. Nouveau reset indépendant pour les deux fichiers concernés ; contrôle Auth **200** et Storage **200**, puis exécution ciblée : **30 tests passants, zéro ignoré**, durée 7,54 s, à 21:45:23. Le cas avec 1 001 événements est exécuté dans le périmètre borné de sa fixture locale existante ; aucun fuzzing ni extraction distant.

Les preuves sont `evidence/s2-s3-independent-*` et `evidence/s2-s3-targeted-*` dans le worktree des preuves. Les journaux historiques rouges sont conservés intacts. Les deux fichiers de tests n'ont pas été corrigés pour obtenir du vert. La préparation de l'environnement n'augmente aucun délai de test.

**Conclusion : NON REPRODUIT dans ces deux exécutions propres, cause historique NON ÉTABLIE — NEEDS INVESTIGATION.** Un problème transitoire de passerelle/Storage est une hypothèse compatible avec certains symptômes, pas un diagnostic prouvé : les sondes réseau de l'exécution rouge n'ont pas été prises. Les différences de dépendances S0/T1 entre l'ancienne et la nouvelle base interdisent aussi d'attribuer la disparition au seul reset. Le passage des tests ne constitue pas un correctif rétroactif.

En cas de récidive : conserver le premier journal avant toute relance, relever santé Auth/REST/Storage et horodatages, collecter des codes d'erreur limités sans corps, jeton ni cookie, puis isoler le premier événement en échec. Ne pas augmenter les timeouts ni remplacer les assertions par des refus systématiques. Si la reprise métier est réellement défaillante, ouvrir un lot correctif avec reproduction rouge et tests positifs d'idempotence.

## Limites et approbations

La politique prévoit un exercice avant tout engagement de RTO/RPO ; aucune sauvegarde distante ni restauration réelle n'a été vérifiée. MFA, accès consoles, destinataires des alertes, rétention et obligations CDP/Shopify restent à confirmer humainement. Les 72 heures concernent la notification RGPD du responsable du traitement lorsque les conditions s'appliquent ; ce n'est pas un délai universel CDP, sous-traitant ou Shopify. Le porteur doit valider la politique et ses capacités opérationnelles avant adoption. Aucun compte n'a été désactivé et aucune clé n'a été tournée dans ce lot.

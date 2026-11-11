# F2 — réservation du quota de génération IA

## Plan et contrat retenus avant implémentation

SEC-G-001 : la route compte les appels d'outils après coup et échoue en mode ouvert. Une conversation sans outil peut donc appeler le fournisseur sans consommer ce plafond. Preuve initiale locale : la 31e génération sans outil reste acceptée ; aucun fournisseur réel n'a été sollicité.

1. Ajouter un moteur pur de réservation Lua atomique, puis un adaptateur Redis utilisant les variables existantes et le contexte Auth validé. Deux sorted sets, utilisateur et tenant, partagent le hash tag du tenant. Les deux limites sont vérifiées avant toute réservation ; aucune réservation partielle.
2. Route : conserver le plafond d'outils existant comme défense complémentaire ; vérifier la conversation puis réserver avant persistance et avant tout appel Groq. Quotas : 30 générations/utilisateur et 120/tenant sur 60 secondes glissantes ; identifiant de réservation aléatoire idempotent. Expiration des clés : 70 secondes. Redis absent, indisponible ou réponse incohérente : 503 et aucun appel fournisseur. Dépassement : 429, Retry-After 60.
3. Compter chaque tentative fournisseur, y compris un échec : une erreur peut intervenir après facturation et un remboursement systématique rendrait la limite contournable. Une erreur avant l'appel peut exceptionnellement conserver une réservation ; elle expire après 60 secondes. Le compteur est une limite de tentatives, pas une facture. Les retries fournisseur existants (3) restent bornés ; une génération peut faire plusieurs étapes/outils (5), ce qui n'est pas une limite monétaire stricte.
4. Comptabiliser séparément les jetons d'entrée/sortie connus et les échecs sans usage connu dans des agrégats Redis quotidiens utilisateur/tenant, conservés 31 jours. Aucun prompt, message ou donnée client. Ne pas inventer un coût : rapprocher les factures/alertes fournisseur ; les jetons en échec peuvent être inconnus. Une panne de télémétrie après réservation ne rembourse pas le quota et n'interrompt pas une réponse déjà payée.
5. Message français dans l'UI pour indisponibilité du quota et limite atteinte, sans afficher le JSON brut. Aucun changement de schéma, de variable de production ni migration.
6. Prouver limites utilisateur/tenant, atomicité concurrente, expiration, idempotence de réservation, panne Redis et échec fournisseur avec des tests unitaires et un vrai Redis local isolé. Vérifier le streaming signé S0 avec ce backend local ; aucune assertion préexistante ne sera affaiblie.

Risques : Redis devient une dépendance de disponibilité de l'assistant ; un tenant actif peut atteindre son plafond commun. Les nouvelles limites nécessitent une validation produit. Les agrégats sont techniques et ne constituent ni une piste comptable ni un plafond en euros/FCFA. Le quota utilisateur est lié au tenant dans le modèle actuel à appartenance unique ; revoir ce contrat si les appartenances deviennent multiples. Une perte de données Redis réinitialise la fenêtre. Le déploiement exige de vérifier la présence effective du backend, sans lire ni changer sa configuration ici.

## Résultats vérifiés

Relecture du diff : la réservation intervient après validation de la conversation et avant `streamText`; identité issue de `resolveIaContext`, aucune donnée de tenant provenant du corps client, aucun service_role. Le client Redis borne les appels à deux secondes et une reprise ; une réponse autre que les entiers attendus échoue en mode fermé. Les callbacks de fin/erreur enregistrent au plus un résultat d'usage par requête, sans erreur fournisseur brute. Les appels d'outils conservent leur propre contrôle existant ; ce contrôle fail-open ne décide plus de l'accès au fournisseur.

| Vérification locale | Résultat |
|---|---|
| TypeScript, lint, build | Verts ; six avertissements lint préexistants |
| Suite unité | 2 065 passants ; trois ignorés préexistants, non comptés comme vérifiés |
| Suite RLS après réinitialisation | 812 passants, aucun ignoré |
| Baseline ACL et inventaire service-role | Verts |
| Nouveau test de route | Cinq cas verts : quota indisponible/atteint sans appel fournisseur ni persistance, conversation invalide sans réservation, succès après réservation, erreur fournisseur sans remboursement ni double comptage |
| Redis réel isolé | Huit cas verts : limite utilisateur, limite tenant sans réservation partielle, concurrence utilisateur (48 demandes/30 admises), concurrence tenant (140/120), fenêtre et TTL, reprise idempotente, backend absent/erroné, séparation jetons/échecs |
| HTTP S0 sur ce build | Quatre cas verts : désinstallation signée et rejouée, streaming authentifié incrémental, chacun en identity/gzip |

La première suite RLS de ce lot a produit **13 échecs / 799 succès** dans deux fichiers WooCommerce. Les identités fixes de ces suites existaient déjà dans la base utilisée par une exécution précédente : quatre correspondances relevées avant reset, zéro après. La suite complète sur base propre passe sans changement de test. Les journaux rouges sont conservés ; ce diagnostic ne prétend pas expliquer les 11 anciens échecs Shopify du lot S3. Après reset, la première sonde Auth est arrivée pendant le redémarrage ; aucun test n'a démarré avant observation du 200.

Le scénario rouge initial SEC-G-001 (31e génération sans outil acceptée) est conservé dans les preuves de l'audit. Les nouvelles régressions n'ont pas été exécutées contre le commit parent ; aucun résultat rouge rétroactif n'est inventé. Les tests de route isolent les services externes ; les tests Redis exécutent le vrai Lua ; HTTP S0 complète par une vraie session et un vrai serveur Next, avec fournisseur SSE simulé. Aucun fournisseur distant, compte réel ni production sollicités.

## Reproduction, CI et limites

```powershell
pnpm exec vitest run tests/unit/ia/generation-quota-route.test.ts
node --test --test-concurrency=1 tests/security/f2-quota-local.mjs
# Avec le build et les variables Supabase locales injectées en mémoire :
node --test --test-concurrency=1 tests/security/s0-success-http.mjs
# Une fois M1 présent dans le checkout :
node tests/security/f2-run-authorization-matrix.mjs
# Validation entre les deux worktrees, avant toute fusion :
node tests/security/f2-run-authorization-matrix.mjs ../security-authorization-matrix/tests/security/m1-authorization-matrix.mjs
```

Intégration M1/F2 : les **1 046 attentes du catalogue initial M1 passent également contre le vrai build F2**, avec Redis réel local injecté explicitement. Aucun merge de branche n'a été nécessaire pour ce test. Le harnais M1 supprime toujours les variables Upstash réelles héritées, puis accepte seulement la fixture loopback fournie par ce wrapper. Aucune assertion, limite ou timeout n'a été affaibli. Cette exécution complète les tests de quotas ; elle ne corrige pas SEC-A-002 ni SEC-C-003 et ne transforme pas les 20 refus HTTP 503 en autorisations vérifiées. La fixture nécessite la version M1 qui la prend en charge ; les deux PR restent indépendantes sur main et le wrapper échoue explicitement si la matrice manque.

Le script autonome importe TypeScript nativement : Node >=22.18 ou Node 24. Redis de test est l'image officielle `redis:8.2.3-alpine`, épinglée au digest `sha256:08ad0b1d280850169a790dba1393ff7a90aef951fc19632cf4d3ce4f78e679ba`, sans réseau ni port publié. Il s'agit d'une dépendance de laboratoire, pas d'une recommandation de version de production. Un pont REST exclusivement loopback reproduit le protocole client existant ; il n'est jamais chargé par l'application déployée. Le harnais S0 reçoit ce nouveau backend synthétique ; ses assertions de succès, signature, effet SQL, rejeu et streaming sont inchangées. Une tentative préliminaire utilisant un chargeur `tsx` absent a échoué avant les tests ; l'exécution native Node a ensuite passé les huit cas.

Les cinq tests Vitest sont inclus dans `test:unit`. Les huit tests Redis et quatre tests HTTP autonomes restent exécutés localement, hors CI automatique : une CI verte ne prouve pas leur exécution. L'adaptateur a été testé contre le pont REST local ; permissions et disponibilité de l'instance Upstash réelle, alertes de coût, stockage et rétention distants restent **NOT TESTED**. L'horloge serveur doit être cohérente entre instances. Aucun plafond de jetons ou de coût facturé n'est garanti ; la génération peut avoir plusieurs étapes et reprises. La validation produit doit confirmer les limites proposées.

## Rollout et retour arrière proposés

PR distincte, **aucune fusion dans ce lot**. Avant autorisation de déploiement : confirmer les plafonds et vérifier manuellement la disponibilité/les permissions du Redis configuré, sans révéler ses credentials ; exécuter un canari synthétique et contrôler les agrégats sans prompt. Sur panne Redis l'assistant seul devient indisponible, les commandes/cash restent opérationnels. Retour arrière sans migration : retirer ce commit applicatif par PR après confinement de l'usage IA coûteux ; restaurer simplement le comportement antérieur réintroduirait SEC-G-001. Les clés de fenêtre expirent seules ; aucune purge ou révocation globale n'est proposée. Verdict : correction préparée et validée localement, risque global toujours **NO-GO** jusqu'aux approbations et contrôles ouverts.

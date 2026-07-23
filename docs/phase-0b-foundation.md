# Phase 0B — socle de lancement

Date de décision : 23 juillet 2026. Ce document consigne des décisions validées ; il ne vaut ni soumission partenaire ni preuve d'un accès externe.

## Décisions figées

- Le lancement comporte Shopify, WooCommerce, YouCan et l'ingestion générique (saisie manuelle, WhatsApp, TikTok, Facebook, Instagram, téléphone, CSV et API générique). Meta/TikTok direct ne font pas partie du prérequis.
- Tëër est un SaaS autonome et Shopify est un connecteur, non le socle. KOBA reste le connecteur pilote ; toute évolution vers Teer Public relève du conditionnel ci-dessous.
- `merchant_account` est l'organisation. Une organisation possède plusieurs boutiques et les accès boutique seront des memberships explicites (Phase 1).
- YouCan est obligatoire avant lancement si sa faisabilité technique est confirmée. Toute impossibilité officielle nécessite une décision écrite d'Ablaye.
- Ordre impératif : Phase 1 workspace/RLS, Phase 2 modèle canonique + Shopify, Phase 3 ingestion commune, connecteurs, onboarding/gouvernance, conformité/facturation, UX, finance/exports/qualification.
- Les états actuels restent la baseline jusqu'à l'alignement Phase 2 ; aucun nouvel état métier n'est ajouté en Phase 0B.
- L'unité commerciale et facturable est `merchant_account`, jamais la boutique. Un abonnement peut autoriser plusieurs boutiques selon les limites du forfait, sans créer un abonnement par ajout. Chaque boutique garde toutefois des données strictement isolées. Le provider de boutique ne détermine pas le provider de facturation.
- La facturation au niveau `merchant_account` appartient à la Phase 7 ; aucune dépendance à Shopify Billing n'est implémentée.
- `main` doit rester protégée : PR obligatoire, zéro approbation obligatoire pour le fondateur solo, checks Linux requis, pas de force-push ni suppression. Exception : une modification d'urgence passe par PR documentée ; aucun push direct ordinaire.

### Facturation et distribution Shopify — CONDITIONNEL

Propriétaire de la levée du conditionnel : **Ablaye**, sur la base d'une réponse écrite de Shopify explicitement rattachée à Teer Public / à son App ID.

- **BRANCHE A — autorisation écrite Shopify accordée :** Teer Public peut être distribué publiquement comme connecteur gratuit à visibilité limitée ; Tëër conserve un abonnement externe unique au niveau de `merchant_account`, couvrant les boutiques autorisées, sans Shopify Billing. La preuve doit autoriser explicitement cette facturation externe.
- **BRANCHE B — autorisation Shopify refusée :** aucune soumission publique de Teer Public ne s'appuie sur une facturation externe. Les installations Shopify restent temporairement custom et accompagnées ; le lancement priorise WooCommerce, les commandes manuelles et les imports. Toute autre décision de distribution ou de facturation exige une décision explicite d'Ablaye avant l'implémentation de la Phase 7.

## Actions externes

| Action | Propriétaire | État | Preuve attendue | Phase limite | Blocage |
|---|---|---|---|---|---|
| Partner Shopify et ownership | Ablaye | À ouvrir | accès Partner + propriétaire identifié | avant soumission | compte partenaire |
| Autorisation Shopify — facturation externe de Teer Public | Ablaye | Envoyée — réponse écrite en attente | numéro du ticket et réponse Shopify explicitement rattachée à Teer Public / à son App ID | avant soumission publique Shopify et avant décision finale de facturation Phase 7 | cette attente ne bloque pas la Phase 1 |
| URL production et redirect URIs | Ablaye | À confirmer | URLs enregistrées et test OAuth | avant soumission | domaine final |
| Boutique dev tierce | Ablaye | À ouvrir | installation test indépendante | avant soumission | boutique Shopify |
| Protected Customer Data/scopes/listing | Ablaye | À préparer | demande, justifications, captures et accusé Shopify | avant soumission | Partner Shopify |
| WooCommerce HTTPS, REST v3, webhooks | Ablaye | À ouvrir | boutique sandbox + clés test + livraison webhook | avant connecteur | boutique test |
| YouCan compte/API/OAuth/webhooks | Ablaye | À ouvrir | compte réel + documentation officielle + test technique | avant connecteur | accès YouCan |
| Domaine transactionnel, SPF/DKIM/DMARC | Ablaye | À ouvrir | enregistrements DNS et test de délivrabilité | avant lancement | DNS/fournisseur email |
| Sentry et alertes | Ablaye | À ouvrir | projet, DSN configuré, alerte testée | avant lancement | compte Sentry |
| Vercel/Supabase, sauvegarde/restauration | Ablaye | À confirmer | accès nominatif, sauvegarde et exercice de restauration | avant lancement | comptes cloud |
| CDP/transfert UE/DPA | Ablaye + conseil | À ouvrir | analyse, démarche et contrats conservés | avant lancement | décision juridique |
| Prestataire XOF et sandbox | Ablaye | À choisir | contrat/intégration sandbox | avant facturation directe | prestataire |

## Preuves techniques Phase 0B

- Les migrations production sont attestées en lecture seule par `pnpm exec supabase migration list --linked` : `0001` à `0111` sont alignées local/remote.
- Les webhooks distinguent HMAC invalide (`401`) et requête authentique d'une boutique absente (`200`, sans `shop_id` ni `merchant_account_id` sur l'événement). Les scénarios E2E couvrent cette séparation, l'idempotence, GDPR et désinstallation ; la CI les exécute avec une clé Shopify contrôlée uniquement pour les tests.
- La protection GitHub de `main` est l'autorité de gouvernance ; ses checks requis sont configurés dans GitHub, pas déduits du seul fichier de workflow.

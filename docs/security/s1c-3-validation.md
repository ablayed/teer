# S1C-3 — preuves dynamiques et inventaire des surfaces PCD

S1C-3 clôture la validation locale de S1C. Il ne crée pas de nouveau journal :
les surfaces ci-dessous réutilisent `writePcdAccessAudit` et les contrôles SQL
de `0123`/`0124`.

## Inventaire déclaré

| Surface | Point d’entrée | Catégories | Rôles / portée | Audit et échec | Preuve S1C-3 |
| --- | --- | --- | --- | --- | --- |
| Commandes, recherche et listes | `lib/actions/orders.ts` (`getOrders`, `getOrdersPageData`, `loadMoreOrdersAction`) | identité, contact, adresse | owner/manager/agent, tenant + boutique | événement agrégé ; aucune réponse PCD si l’audit échoue | `tests/unit/security/s1c3-validation.test.ts`, RLS S1C-1 |
| Détail commande et adresse | `lib/actions/orders.ts` (`getOrderById`) | identité, contact, adresse | membre autorisé, tenant + boutique | événement unitaire ; fail-closed | test unitaire de contrat + RLS produit existant |
| Clients et recherche client | `lib/actions/customers.ts` (`listCustomersAction`, `getCustomerAction`) | identité, contact, adresse | owner/manager/agent, tenant | quota puis événement ; réponse fermée si audit indisponible | test unitaire de contrat + RLS produit existant |
| Livreurs / équipe | `lib/actions/team.ts`, `app/(app)/livreurs/page.tsx` | member_data, contact | capacités métier et tenant | événement contrôlé ; pas de valeur libre | test statique d’inventaire |
| Finance / rapport PDF | `app/api/rapport/route.tsx`, `lib/actions/finance.ts` | member_data, merchant_data | owner/manager, tenant + boutique, réauthentification pour PDF | quota, bornes, audit avant remise, no-store | test de contrat S1C-2 |
| DSAR | `app/api/shopify/dsar/[artifactId]/route.ts`, `download/route.ts`, `lib/shopify/dsar.ts` | dsar_artifact | owner/manager, tenant + boutique, réauthentification | autorisation one-shot et audit avant contenu ; refus générique | `tests/rls/s1c3-dsar-one-shot.rls.test.ts` |
| Shopify et workers | `app/api/shopify/webhooks/route.ts`, `app/api/cron/*`, `lib/shopify/*` | shopify_payload, dsar_artifact | service fermé, tenant + boutique explicites | événement service ; jamais de payload dans l’audit | test statique DLP + RLS existant |
| Assistant IA | `app/api/assistant/chat/route.ts`, `lib/ia/audit.ts` | identité, contact, adresse, merchant_data | membre autorisé, tenant | détecteur déterministe ; refus avant persistance/Groq | test DLP S1C-1 + test statique |
| Feedback / Resend | `lib/actions/feedback.ts` | member_data, merchant_data | membre autorisé, tenant | détection avant persistance et transmission | test DLP S1C-1 + test statique |
| WhatsApp | `lib/actions/pcd-access.ts`, `components/whatsapp/*` | contact, adresse | action explicite de l’utilisateur, tenant + boutique | `external_share` avant ouverture ; URL et texte hors audit/télémétrie | test statique + test unitaire DLP |
| Sentry / PostHog / logs | `sentry.client.config.ts`, `lib/security/telemetry-sanitize.ts` | aucune valeur PCD | infrastructure applicative | chemins et codes techniques uniquement | `tests/unit/security/s1c3-validation.test.ts` |

Les composants purement visuels et les migrations historiques ne constituent pas
des points d’accès supplémentaires : ils ne lisent pas de PCD et ne sont pas
déclarés comme routes sensibles.

## Contrats de preuve

- Les listes produisent un événement par requête, avec pagination et compteur
  bornés, jamais un événement par ligne.
- Les détails, recherches, exports, PDF, DSAR et partages sont fail-closed :
  une panne d’audit ne remet aucun contenu PCD au navigateur.
- Les audits, compteurs et autorisations n’acceptent ni valeur de recherche,
  ni identité, téléphone, adresse, contenu DSAR, payload, URL, token, hash,
  exception ou objet métier brut.
- Le test RLS DSAR utilise deux clients authentifiés indépendants pour prouver
  la consommation atomique. Les fixtures sont synthétiques et aucun secret,
  token ou contenu d’artefact n’est affiché.
- `purge_pcd_access_controls` reste un nettoyage local, borné et service-only.
  Aucun cron ou mécanisme distant n’est activé.

## Limites et frontière S1D

Le détecteur DLP reste déterministe et couvre seulement les formes explicites
documentées ; il ne constitue pas une détection sémantique complète. Les
preuves de production, le chiffrement, les clés, les sauvegardes, la continuité
et la réponse aux incidents restent reportés à S1D.

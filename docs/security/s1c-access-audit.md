# S1C-1 — fondation du journal d’accès PCD

## Contrat

La migration `0123_s1c_pcd_access_audit.sql` crée `pcd_access_audit`, distinct de
`audit_log`. Les événements contiennent uniquement des catégories, des codes,
des identifiants internes, la portée tenant/boutique et des métadonnées techniques
allow-listées. Les noms, téléphones, adresses, recherches, payloads, messages,
arguments, URLs, tokens, exceptions et corps de requêtes sont interdits.

L’acteur humain est dérivé de `auth.uid()` par la RPC. Un acteur de service doit
utiliser une session `service_role` et déclarer un `service_kind` contrôlé. Aucun
`actor_user_id`, `tenant_id` ou `shop_id` n’est accepté depuis le navigateur comme
identité d’acteur : la RPC vérifie tenant et boutique.

La lecture MVP est owner-only et isolée au tenant. Il n’existe aucune policy
d’écriture applicative. UPDATE et DELETE sont bloqués par trigger ; seule la
fonction de maintenance service-only peut purger un lot borné avec le GUC
`app.pcd_access_audit_maintenance` explicitement positionné.

## Surfaces instrumentées dans S1C-1

- génération d’artefact DSAR par le worker Shopify ;
- génération d’URL signée DSAR, après contrôle tenant+boutique ;
- téléchargement proxy DSAR, avec réponse `no-store` ;
- partage WhatsApp après action serveur d’autorisation ;
- traitement IA accepté, refusé ou en échec ;
- feedback accepté ou refusé par le détecteur DLP.

Les lectures ordinaires de commandes, clients et adresses restent réservées à
S1C-2.

## DLP immédiate

Sentry conserve uniquement le chemin normalisé, les types et des métadonnées
techniques. Query strings, fragments, URLs, breadcrumbs libres, messages et
valeurs d’exception sont supprimés ou remplacés par des codes.

PostHog nettoie les propriétés de query, URL, referrer, message, payload et
exception avant envoi. La recherche `/commandes` conserve son état applicatif
local ; sa query string n’est plus transmise par Sentry ou PostHog.

L’IA refuse les formes explicitement détectables de téléphone, email, adresse et
libellés d’identité avant persistance ou envoi à Groq. Le détecteur est
déterministe et volontairement incomplet : il ne prétend pas détecter toute
formulation sémantique d’un nom ou d’une adresse.

Le feedback sensible est refusé avant DB et Resend. Le partage WhatsApp reste
une action utilisateur explicite ; le lien peut encore contenir les données
nécessaires au transfert vers WhatsApp, mais ce lien n’est ni journalisé ni
envoyé à Sentry, PostHog ou la console.

## Rétention

`PCD_ACCESS_AUDIT_RETENTION_MONTHS = 12` est une décision produit provisoire,
configurable par le cutoff fourni à `purge_pcd_access_audit`. Elle ne constitue
pas une durée légale affirmée. La fonction est bornée à 500 lignes, service-only,
et n’est appelée par aucun cron dans S1C-1. Aucune activation distante n’est
effectuée.

## Reporté à S1C-2

- instrumentation exhaustive des listes et détails ordinaires ;
- quotas et rate limiting complets des exports ;
- téléchargement one-shot des URLs signées ;
- stratégie de rétention opérationnelle automatisée ;
- revue DLP sémantique avancée.

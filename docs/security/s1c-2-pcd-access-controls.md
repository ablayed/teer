# S1C-2 — instrumentation exhaustive et anti-exfiltration PCD

## Portée

S1C-2 réutilise `pcd_access_audit` et `writePcdAccessAudit` de S1C-1. La
migration `0124_s1c2_pcd_access_controls.sql` ajoute les contrôles bornés des
accès et copies PCD, sans modifier les migrations 0120 à 0123.

Les surfaces couvertes sont les listes, recherches et détails commandes et
clients, les écrans livreurs/équipe et rapprochement, les synchronisations
Shopify/webhooks/Bulk Operations/DSAR, le rapport PDF financier, le partage
WhatsApp, l'assistant IA, le feedback, Resend, Sentry et PostHog. Les listes
sont auditées par requête, jamais par ligne. Les retours contenant des PCD sont
fail-closed si l'audit obligatoire échoue.

La recherche applicative utilise POST afin de ne plus placer sa valeur dans
l'URL. Le GET historique reste borné et assaini par les garde-fous de S1C-1.

## Contrôles SQL

`pcd_access_audit` reçoit une clé d'idempotence technique optionnelle, limitée
à 128 caractères et sans valeur libre. Une clé réutilisée ne crée pas une
seconde ligne et ne modifie pas la première.

Les compteurs persistants sont isolés par tenant, boutique, acteur ou identité
de service et action. Ils sont consommés dans une RPC atomique et ne sont pas
directement inscriptibles par `PUBLIC`, `anon` ou `authenticated`.

Les limites produit provisoires sont : 500 lignes, 5 Mio, cinq exports par
quinze minutes, trois autorisations DSAR par jour, cinq téléchargements DSAR
par quinze minutes, vingt partages externes par quinze minutes et soixante
recherches PCD par minute. Elles ne constituent pas des obligations légales.

## DSAR one-shot

L'autorisation DSAR est liée à l'acteur, au tenant, à la boutique, à l'artefact
interne et à `legal_request`. Le serveur génère un jeton opaque ; seule son
empreinte SHA-256 est stockée. Le téléchargement authentifié reçoit le jeton
dans `x-teer-dsar-download-token`, le consomme atomiquement et refuse toute
seconde utilisation, expiration ou changement de portée. Il télécharge
directement depuis Storage côté serveur et ne redirige pas vers une URL Storage.

Le jeton, son empreinte, le chemin Storage et le contenu de l'artefact ne sont
jamais écrits dans l'audit, les logs, Sentry ou PostHog. La génération et le
téléchargement sont deux événements distincts. Si l'audit de téléchargement
échoue après consommation, aucun contenu n'est retourné et le jeton reste
consommé, ce qui évite une réutilisation après panne d'audit.

## Réauthentification et nettoyage

Les exports sensibles, le rapport PDF et les opérations DSAR vérifient côté
serveur `auth.getUser().last_sign_in_at` dans une fenêtre configurable de
quinze minutes. Aucun timestamp ou booléen fourni par le navigateur n'est
accepté.

`purge_pcd_access_controls` est une fonction service-only, bornée à 500 lignes,
prévue pour un lancement local explicite. Aucun cron distant, aucune activation
distante et aucune modification de `vercel.json` ne sont inclus.

## Données interdites et limites DLP

Les audits, compteurs et métadonnées n'acceptent ni nom, téléphone, adresse,
requête, payload, texte DSAR, message, argument, URL, jeton, exception ou corps
de requête. Les erreurs sont converties en codes sanitaires. Les tests utilisent
uniquement des identifiants, libellés et chemins manifestement synthétiques.

Le détecteur IA/feedback couvre des formes explicites de contact, email,
adresse et libellés d'identité. Il ne garantit pas une détection sémantique
complète des noms ou adresses libres ; cette limite reste documentée.

## Rôles et périmètre

Les consultations ordinaires conservent les capacités produit owner/manager/
agent et le scoping RLS existant. Le journal reste owner-only. Les exports PDF
et DSAR sont owner/manager. Les identités de service sont limitées aux valeurs
fermées du contrat et ne sont jamais considérées comme autorisées uniquement
parce qu'elles contournent RLS.

Le chiffrement, les sauvegardes, la rotation de clés, la réponse aux incidents,
la continuité et les accès infrastructure restent hors S1C et relèvent de S1D.

# S1C — journal d'accès PCD

La migration `0123_s1c_pcd_access_audit.sql` fonde `pcd_access_audit`, distinct
de `audit_log`. Le journal ne stocke que des catégories, codes, identifiants
internes, portée tenant/boutique et métadonnées techniques allow-listées. Les
valeurs PCD, recherches, payloads, messages, URLs, tokens, exceptions et corps
de requêtes sont interdits.

L'acteur humain est dérivé de `auth.uid()` par la RPC. Un acteur de service
déclare un `service_kind` fermé. La lecture MVP est owner-only et isolée au
tenant ; UPDATE et DELETE sont bloqués par trigger.

S1C-1 a posé les garde-fous Sentry, PostHog, IA, feedback, DSAR et WhatsApp.
Les listes et détails ordinaires, quotas, réauthentification, DSAR one-shot et
contrôles anti-exfiltration S1C-2 sont documentés dans
[`s1c-2-pcd-access-controls.md`](./s1c-2-pcd-access-controls.md).

La détection DLP IA/feedback reste déterministe et limitée aux formes
explicites documentées ; elle ne constitue pas une garantie sémantique complète.
Le chiffrement, les sauvegardes, la rotation de clés, la réponse aux incidents
et les accès infrastructure restent hors S1C et relèvent de S1D.

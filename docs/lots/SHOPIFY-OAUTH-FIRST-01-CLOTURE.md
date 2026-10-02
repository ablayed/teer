# SHOPIFY-OAUTH-FIRST-01 — verdict de clôture

Verdict du porteur, repris tel quel.

> **Lot clos avec réserves acceptées.**
>
> Fusion par squash le 2026-10-02 (`71c51d7`, arbre identique à `278d61d`). Deux exécutions CI initiales vertes sur `278d61d` (`36759063607`, `36761506950`), lues test par test. CI post-fusion `37063525720` verte sur `71c51d7` : les 28 jobs ont une conclusion vérifiée, **sans lecture test par test**.
>
> **Mesures en production, le 2026-10-02**
> - S1 (boutique neuve, sans session) : la première page Tëër servie en 200 (`/connexion`) **suit** `authorize` et le callback, qui n'est appelé qu'une fois.
> - Marchand neuf : inscription Gmail, confirmation dans le même navigateur, confirmation explicite, rattachement réussi.
> - Ouverture depuis l'admin : aucun nouveau grant (1 audit `shopify.connected`, 0 audit de branche 1).
> - S3 : désinstallation traitée (« Déconnectée »), réinstallation en branche 2, confirmation, puis « Connectée ».
> - Synchronisation des produits après rattachement : produits présents dans la boutique rattachée.
> - Contrôles automatiques Shopify : **les cinq sont verts**. Ils valident ces cinq contrôles précis. **Ils ne valent pas acceptation générale de l'app.**
>
> **Réserves acceptées**
> 1. Mesure Q1 « avant » non réalisée en production. L'état « avant » est établi par lecture du code (DIAG-SUBMISSION-BLOCKERS-01, Q1).
> 2. S2 et le parcours « boutique déconnectée » ne sont pas mesurés en production. Ils sont couverts par T4, T22 et T22c.
> 3. **Fenêtre concurrente de désinstallation** : une attente créée entre la vérification hors verrou et la désinstallation peut survivre (`webhook-core.ts:918-927`). Elle est conservée ici et **traitée dans le lot 1b**.
> 4. Les mutations T1–T38 et R3 ont été mesurées sur `3a2b576`. Seules celles de T12b l'ont été sur `278d61d`.
> 5. D20a : la remise à NULL de la charge utile est établie par le code, pas par une mesure directe. L'échec de finalisation (charge bloquée en `processing`) relève du lot 2.
> 6. Relevé « avant » de `persist_shopify_credentials_fenced` en production non réalisé. La conformité « après » est établie par la comparaison d'**extraits ciblés** du catalogue local et de production (1 708 lignes identiques). Les objets comparés sont : les corps des 8 fonctions, la définition et les grants de `shopify_pending_installation`, la colonne `shop.reauthorization_required_at`, et les droits de `shop`, `store_connection` et `shopify_token_lease`. **Cette preuve ne s'étend pas au reste du catalogue.**
>
> **Hors de ce lot** : la synchronisation des **commandes** n'est pas mesurée. Les produits seuls ont été prouvés. Les commandes relèvent du lot 1b.

## Dossier de preuves hors dépôt

| Élément | Valeur |
|---|---|
| Chemin | `C:\Users\diaab\teer-preuves\2026-09-29-SHOPIFY-OAUTH-FIRST-01\DOSSIER-CLOTURE-SHOPIFY-OAUTH-FIRST-01.md` |
| sha256 | `ae519ba530bf63b54f91e6bc0f7da35f8a07e7b1417c321dcd9c1e3b4b856b89` |

Empreinte recalculée le 2026-10-02, avant l'écriture de ce document : identique.

## Renvois

- Attestation de la migration : `docs/security/ATTESTATION-0160-2026-09-29.md`.
- Dettes et réserves ouvertes par le lot : `CLAUDE.md`, section « Dettes et réserves ouvertes par SHOPIFY-OAUTH-FIRST-01 ».

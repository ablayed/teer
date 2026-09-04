# S4 — Énumération des routines SECURITY DEFINER exécutables par `authenticated`

Mesuré sur stack locale (migrée à `0150`), schémas `public`+`graphql_public` (confirmés identiques à
`supabase/config.toml` en Étape 0), via `collectFunctions()` de `scripts/lib/acl-snapshot.mjs` —
`has_function_privilege`, jamais `proacl` seul. Fonctions `return_type = trigger` exclues (non
invocables directement, motif déjà établi par la Couche 1 existante).

**39 routines SECURITY DEFINER sont exécutables par `authenticated` dans les schémas exposés**, sur
107 fonctions scannées au total. Les 39 portent toutes un `search_path` explicite dans `proconfig`
(aucune violation sur ce point précis — bonne nouvelle indépendante de l'arbitrage ci-dessous).

## Table — routine, test existant, couverture double-axe

Couverture mesurée par une recherche heuristique (mots-clés anglais/français désignant une deuxième
boutique ou un deuxième compte dans le fichier de test cité) — **pas une lecture ligne à ligne des 39
fichiers**. Une entrée "0/0" signifie soit une absence réelle de couverture double-axe, soit un test
qui couvre l'axe autrement (variables nommées différemment, UUID littéraux) — à vérifier avant de
statuer "covered" en Tâche 3. Seules `correct_purchase_lot_cost`, `receive_purchase_lot` et
`current_shop_role`/`current_member_role` (leurs primitives de garde) ont une couverture confirmée par
ailleurs (CLAUDE.md, lots S1/S3/0147/0148/0150).

| Routine | Test(s) existant(s) | Axe boutique | Axe compte |
|---|---|---|---|
| `accept_invitation` | `invitation-organization-guard.rls.test.ts` | 0 | 2 |
| `accept_pending_invitation_by_email` | `pending-invitation-by-email.rls.test.ts` | 0 | 4 |
| `cash_aging` | **NONE** | — | — |
| `consume_pcd_access_quota` | `s1c2-pcd-access-controls.rls.test.ts` | 0 | 0 |
| `consume_shopify_dsar_download_authorization` | `s1c3-dsar-one-shot.rls.test.ts`, 2 unit | 3 | 0 |
| `correct_purchase_lot_cost` | `lot-f1-finances-v2-socle`, `lot-f2-purchase-lot-profitability`, `lot-s3-receive-purchase-lot-shop-guard` | 10 | 0 |
| `current_member_role` | `lot-s3-receive-purchase-lot-shop-guard`, `order-note`, `tenant-isolation`, `workspace-store-function-derivation` | 1 | 0 |
| `current_shop_role` | `lot-f1-finances-v2-socle`, `lot-f2-purchase-lot-profitability`, `lot-s3-receive-purchase-lot-shop-guard` | 10 | 0 |
| `finance_kpis` | `finance-delivered-count`, `finance-driver-cash`, `finance-kpis-cash-collected-at`, 2 unit | 3 | 0 |
| `get_dashboard_cash_collected_total` | `dashboard-period-metrics.rls.test.ts` | 4 | 0 |
| `get_dashboard_deliveries_by_product` | `dashboard-period-metrics.rls.test.ts` | 4 | 0 |
| `get_dashboard_shop_performance` | `dashboard-period-metrics.rls.test.ts` | 4 | 0 |
| `get_driver_cash_consolidation` | `dashboard-period-metrics`, `finance-driver-cash` | 7 | 0 |
| `get_driver_cash_outstanding_orders` | `finance-driver-cash.rls.test.ts` | 3 | 0 |
| `get_my_store` | `workspace-store.rls.test.ts` | 5 | 0 |
| `get_report_driver_cash_pending` | `finance-driver-cash.rls.test.ts` | 3 | 0 |
| `get_report_revenue_by_day` | `report-non-cash-aggregates.rls.test.ts` | 2 | 0 |
| `get_report_status_breakdown` | `report-non-cash-aggregates.rls.test.ts` | 2 | 0 |
| `get_report_top_products` | `report-non-cash-aggregates.rls.test.ts` | 2 | 0 |
| `ia_count_recent_tool_calls` | `ia-assistant.rls.test.ts` | 0 | 0 |
| `ia_finance_cost_movements` | `ia-assistant.rls.test.ts` | 0 | 0 |
| `ia_product_cump` | `ia-assistant.rls.test.ts` | 0 | 0 |
| `is_driver_in_shop` | `driver-store-scope.rls.test.ts`, 1 unit | 2 | 0 |
| `is_member_of` | `tenant-isolation.rls.test.ts` | 0 | 0 |
| `is_shop_member_of` | **NONE** | — | — |
| `issue_shopify_dsar_download_authorization` | `s1c3-dsar-one-shot.rls.test.ts`, 1 unit | 3 | 0 |
| `list_my_pending_invitations` | `pending-invitation-by-email.rls.test.ts` | 0 | 4 |
| `list_my_stores` | **NONE** | — | — |
| `log_ia_tool_audit` | `ia-assistant`, `red-team`, `lot4a-migration-revoke-pairing` | 0 | 0 |
| `log_pcd_access_event` | `s1c-pcd-access-audit`, `s1d3-audit-rpc-hardening`, 1 unit | 0 | 0 |
| `post_stock_movement` | 8 fichiers rls (driver-shop-eligibility-gate, driver-stock, lot-s3, order-cart-reduction, product-bundle-cascade, stock-atomicity, stock, workspace-store-function-derivation) | 5 | 0 |
| `purge_pcd_access_audit` | **NONE** | — | — |
| `receive_purchase_lot` | `lot-f1`, `lot-f2`, `lot-f2bis-ad-spend-separation`, `lot-s3-receive-purchase-lot-shop-guard`, `purchases` | 10 | 0 |
| `record_cash_settlement` | `finance-driver-cash`, `cash-consolidation`(unit), `lot4a-migration-revoke-pairing` | 3 | 0 |
| `reduce_order_cart_post_assignment` | `order-cart-reduction.rls.test.ts` | 0 | 0 |
| `replace_order_cart` | `order-cart-editing.rls.test.ts` | 0 | 0 |
| `reserve_manual_order_number` | `orders-dimensions.rls.test.ts` | 0 | 0 |
| `set_order_note` | `order-note.rls.test.ts` | 0 | 0 |
| `write_off_shortfall` | `lot4a-migration-revoke-pairing.test.ts` | 0 | 0 |

**4 routines sans aucun test connu (grep exact du nom) : `cash_aging`, `is_shop_member_of`,
`list_my_stores`, `purge_pcd_access_audit`.**

**Aucune routine, sur les 39, n'a de correspondance heuristique positive simultanée sur les deux axes**
(shop ET compte) dans un même fichier — soit parce que la garde ne s'y prête pas (ex. `is_member_of`,
`list_my_stores` : portée par le compte de l'appelant, pas par un id shop transmis — l'axe "boutique"
n'a pas de sens pour elles), soit parce que le test existant ne couvre réellement qu'un axe, soit parce
que l'heuristique par mots-clés rate un test qui couvre l'axe autrement (UUID nommés différemment).
**Cette table ne peut pas, en l'état, servir de base directe à un statut "covered" en Tâche 3 — elle
sert à cadrer l'ampleur de la décision ci-dessous, pas à la remplacer.**

## Les deux options — décision requise avant la Tâche 3

- **Fermeture complète** : les 39 routines (ou le sous-ensemble réellement exposé au risque visé —
  certaines comme `current_member_role`/`is_member_of`/`get_my_store` sont des primitives de lecture
  scoping-only, pas des écritures dérivant un contexte d'un id client) sont vérifiées une à une, avec
  un test double-axe écrit ou confirmé pour chacune, avant que l'assertion de catalogue devienne
  bloquante. **Coût estimé : jusqu'à 39 vérifications/tests, dont au moins les 4 sans aucune
  couverture connue et la confirmation manuelle des ~35 autres où l'heuristique n'a pas tranché.**
- **Ratchet** : les routines non couvertes aujourd'hui sont admises dans la liste blanche avec un état
  `legacy-uncovered`, une date (`2026-09-04`), et une dette explicite par entrée. L'assertion de
  catalogue devient bloquante immédiatement pour toute NOUVELLE routine SECURITY DEFINER×authenticated
  qui apparaîtrait sans y être inscrite — elle ferme la porte à une 5ᵉ occurrence de la classe décrite
  par le lot, sans fermer l'arriéré des 39 existantes dans ce lot.

Aucune recommandation entre les deux — les deux sont défendables, et le coût de la première (potentiellement
plusieurs dizaines de tests de frontière à écrire et vérifier un par un) doit être pesé consciemment,
pas découvert après coup.

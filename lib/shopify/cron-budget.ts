// SHOPIFY-WEBHOOKS-PER-SHOP-1B / G13 — contrôle du temps restant du cron `shopify-reconcile`.
//
// Le cron dispose de `maxDuration = 300` secondes POUR L'ENSEMBLE des boutiques, traitées en
// séquence (dette nommée du lot : ce budget n'est pas par boutique). Une boutique lancée trop
// tard serait coupée en plein traitement par la plateforme : elle est donc SAUTÉE et consignée,
// jamais lancée. Le prochain passage la reprendra.
//
// Module pur : aucune dépendance d'environnement.

// Doit rester égal au `maxDuration` de app/api/cron/shopify-reconcile/route.ts, en millisecondes
// (verrouillé par tests/unit/shopify/cron-budget.test.ts).
export const SHOPIFY_RECONCILE_CRON_BUDGET_MS = 300_000;

// Temps minimal qui doit rester pour LANCER une boutique : le TTL du bail de réconciliation des
// abonnements (60 s, borne haute de cette étape), plus une marge pour la réconciliation des
// commandes qui la suit.
export const SHOPIFY_RECONCILE_MIN_REMAINING_MS = 90_000;

export function remainingCronBudgetMs(startedAtMs: number, nowMs: number): number {
  return SHOPIFY_RECONCILE_CRON_BUDGET_MS - (nowMs - startedAtMs);
}

export function canStartShopReconcile(startedAtMs: number, nowMs: number): boolean {
  return remainingCronBudgetMs(startedAtMs, nowMs) >= SHOPIFY_RECONCILE_MIN_REMAINING_MS;
}

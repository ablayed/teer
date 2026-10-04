// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C4 — contrôle du temps restant du cron `shopify-reconcile`, et
// ordre des deux réconciliations dans la route.
//
// Couche : unitaire. La fonction de budget est pure ; la route est lue comme TEXTE pour verrouiller
// ce qu'un test d'exécution ne peut pas voir sans l'environnement complet (son `maxDuration`,
// lu statiquement par la plateforme, et l'ordre des deux étapes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHOPIFY_RECONCILE_CRON_BUDGET_MS,
  SHOPIFY_RECONCILE_MIN_REMAINING_MS,
  canStartShopReconcile,
  remainingCronBudgetMs,
} from '@/lib/shopify/cron-budget';
import { SHOPIFY_WEBHOOK_RECONCILE_LEASE_TTL_SECONDS } from '@/lib/shopify/webhook-subscription-reconcile';
import { describe, expect, it } from 'vitest';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/shopify-reconcile/route.ts'), 'utf8');

describe('budget du cron shopify-reconcile', () => {
  it('reste égal au maxDuration déclaré par la route', () => {
    const declared = ROUTE.match(/export const maxDuration = (\d+);/)?.[1];
    expect(Number(declared) * 1000).toBe(SHOPIFY_RECONCILE_CRON_BUDGET_MS);
  });

  it('exige au moins le TTL du bail de réconciliation pour lancer une boutique', () => {
    expect(SHOPIFY_RECONCILE_MIN_REMAINING_MS).toBeGreaterThanOrEqual(
      SHOPIFY_WEBHOOK_RECONCILE_LEASE_TTL_SECONDS * 1000,
    );
  });

  it('lance une boutique tant que le temps restant suffit', () => {
    expect(canStartShopReconcile(0, 0)).toBe(true);
    const lastStart = SHOPIFY_RECONCILE_CRON_BUDGET_MS - SHOPIFY_RECONCILE_MIN_REMAINING_MS;
    expect(canStartShopReconcile(1_000, 1_000 + lastStart)).toBe(true);
    expect(remainingCronBudgetMs(1_000, 1_000 + lastStart)).toBe(
      SHOPIFY_RECONCILE_MIN_REMAINING_MS,
    );
  });

  it('saute la boutique dès que le temps restant est insuffisant', () => {
    const lastStart = SHOPIFY_RECONCILE_CRON_BUDGET_MS - SHOPIFY_RECONCILE_MIN_REMAINING_MS;
    expect(canStartShopReconcile(1_000, 1_000 + lastStart + 1)).toBe(false);
    expect(canStartShopReconcile(0, SHOPIFY_RECONCILE_CRON_BUDGET_MS + 5_000)).toBe(false);
  });
});

describe('route du cron — ordre et isolation des deux réconciliations', () => {
  const budgetCheck = ROUTE.indexOf('canStartShopReconcile(startedAt, Date.now())');
  const webhooks = ROUTE.indexOf('await reconcileShopifyWebhookSubscriptions(');
  const orders = ROUTE.indexOf('await reconcileShopOrders(');

  it('contrôle le budget, puis réconcilie les abonnements AVANT les commandes', () => {
    expect(budgetCheck).toBeGreaterThan(-1);
    expect(webhooks).toBeGreaterThan(budgetCheck);
    expect(orders).toBeGreaterThan(webhooks);
  });

  it('une boutique sautée est consignée et n’est pas lancée', () => {
    const skipBlock = ROUTE.slice(budgetCheck, webhooks);
    expect(skipBlock).toContain("detail: 'skipped_time_budget'");
    expect(skipBlock).toContain('continue;');
  });

  it('tient la réconciliation des abonnements dans son propre try/catch, en mode réparation', () => {
    const block = ROUTE.slice(ROUTE.lastIndexOf('try {', webhooks), orders);
    expect(block).toContain("mode: 'repair'");
    expect(block).toMatch(/\} catch \{\s+webhooks = 'exception';\s+\}/);
  });
});

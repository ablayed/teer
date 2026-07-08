import messages from '@/messages/fr.json';
import { expect, test } from '@playwright/test';
import { hasSupabaseAdmin } from '../e2e/helpers/auth';
import {
  cleanupVisualFixture,
  createVisualFixture,
  seedAnalyticsVisualData,
  seedClientsVisualData,
  seedDashboardCashByProductVisualData,
  seedDashboardVisualData,
  seedDriversVisualData,
  seedFinanceVisualData,
  seedOrdersVisualData,
  seedProductsVisualData,
  signInToRoute,
  visualFixedTime,
  visualPeriodFrom,
  visualPeriodTo,
  waitForFonts,
} from '../e2e/helpers/visual-fixtures';

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les baselines visuelles');

test.describe('Baselines visuelles — sections Phase 1', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(visualFixedTime);
  });

  test('clients', async ({ page }) => {
    const fixture = await createVisualFixture('clients');

    try {
      await seedClientsVisualData(fixture);
      await signInToRoute(page, fixture.email, '/clients');
      await expect(page.getByText('Awa Diop').first()).toBeVisible({ timeout: 15_000 });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('clients.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('commandes-liste', async ({ page }) => {
    const fixture = await createVisualFixture('commandes-liste');

    try {
      await seedOrdersVisualData(fixture);
      await signInToRoute(page, fixture.email, '/commandes?from=2026-01-01&to=2026-01-31');
      await expect(page.getByTestId('orders-results')).toBeVisible({ timeout: 15_000 });
      await expect(
        page
          .locator('[data-testid="order-row-title"]:visible', { hasText: 'Mamadou Fall' })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('orders-results')).not.toHaveAttribute('aria-busy', 'true');
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('commandes-liste.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('commandes-detail', async ({ page }) => {
    const fixture = await createVisualFixture('commandes-detail');

    try {
      const { detailOrderId } = await seedOrdersVisualData(fixture);
      await signInToRoute(page, fixture.email, `/commandes/${detailOrderId}`);
      await expect(page.getByRole('heading', { name: 'Mamadou Fall' })).toBeVisible({
        timeout: 15_000,
      });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('commandes-detail.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('livreurs', async ({ page }) => {
    const fixture = await createVisualFixture('livreurs');

    try {
      const { driverId } = await seedDriversVisualData(fixture);
      await signInToRoute(page, fixture.email, `/livreurs?driver=${driverId}&period=30j`);
      await expect(page.getByTestId('driver-detail-panel')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('driver-detail-panel')).not.toHaveAttribute(
        'aria-busy',
        'true',
      );
      await expect(page.getByRole('heading', { name: 'Moussa Ndiaye' })).toBeVisible({
        timeout: 15_000,
      });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('livreurs.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('produits', async ({ page }) => {
    const fixture = await createVisualFixture('produits');

    try {
      await seedProductsVisualData(fixture);
      await signInToRoute(page, fixture.email, '/produits');
      await expect(page.getByRole('heading', { name: 'Ensemble wax indigo' })).toBeVisible({
        timeout: 15_000,
      });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('produits.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('tableau', async ({ page }) => {
    const fixture = await createVisualFixture('tableau');

    try {
      await seedDashboardVisualData(fixture);
      await signInToRoute(
        page,
        fixture.email,
        `/tableau?from=${visualPeriodFrom}&to=${visualPeriodTo}`,
      );
      await expect(page.getByText('Priorités à traiter')).toBeVisible({ timeout: 15_000 });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('tableau.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('tableau-cash-by-product-compact', async ({ page }) => {
    test.setTimeout(60_000);
    const fixture = await createVisualFixture('tableau-cash-by-product-compact');

    try {
      await seedDashboardCashByProductVisualData(fixture, 3);
      await signInToRoute(
        page,
        fixture.email,
        `/tableau?from=${visualPeriodFrom}&to=${visualPeriodTo}`,
      );
      await expect(page.getByTestId('tableau-cash-by-product-chart')).toBeVisible({
        timeout: 15_000,
      });
      await waitForFonts(page);

      await expect(page.getByTestId('tableau-cash-by-product-card')).toHaveScreenshot(
        'tableau-cash-by-product-compact.png',
      );
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('tableau-cash-by-product-many', async ({ page }) => {
    test.setTimeout(60_000);
    const fixture = await createVisualFixture('tableau-cash-by-product-many');

    try {
      await seedDashboardCashByProductVisualData(fixture, 7);
      await signInToRoute(
        page,
        fixture.email,
        `/tableau?from=${visualPeriodFrom}&to=${visualPeriodTo}`,
      );
      await expect(page.getByTestId('tableau-cash-by-product-chart')).toBeVisible({
        timeout: 15_000,
      });
      await waitForFonts(page);

      await expect(page.getByTestId('tableau-cash-by-product-card')).toHaveScreenshot(
        'tableau-cash-by-product-many.png',
      );
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('finances', async ({ page }) => {
    const fixture = await createVisualFixture('finances');

    try {
      await seedFinanceVisualData(fixture);
      // Plage figée dans l'URL (cf. visualPeriod*) → fenêtre serveur déterministe.
      await signInToRoute(
        page,
        fixture.email,
        `/finances?from=${visualPeriodFrom}&to=${visualPeriodTo}`,
      );
      // Le disclaimer n'est rendu qu'une fois GlobalTabContent (Suspense) résolu.
      await expect(page.getByText(messages.finance.disclaimer, { exact: false })).toBeVisible({
        timeout: 15_000,
      });
      // Graphes Recharts montés (dynamic ssr:false) avant capture.
      await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 15_000 });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('finances.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });

  test('analyses', async ({ page }) => {
    const fixture = await createVisualFixture('analyses');

    try {
      await seedAnalyticsVisualData(fixture);
      await signInToRoute(
        page,
        fixture.email,
        `/analyses?from=${visualPeriodFrom}&to=${visualPeriodTo}`,
      );
      // La page Analyses est un seul await serveur : le h1 (unique) visible = données
      // prêtes. NB : ne pas ancrer sur « Scorecard par canal » — ce titre apparaît deux
      // fois (carte graphique ssr:false + table) → match ambigu / course de montage.
      await expect(page.getByRole('heading', { name: messages.analytics.title })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.locator('.recharts-surface').first()).toBeVisible({ timeout: 15_000 });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('analyses.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });
});

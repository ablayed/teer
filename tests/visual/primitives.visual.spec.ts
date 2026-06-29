import { expect, test } from '@playwright/test';
import { hasSupabaseAdmin } from '../e2e/helpers/auth';
import {
  cleanupVisualFixture,
  createVisualFixture,
  signInToRoute,
  visualFixedTime,
  waitForFonts,
} from '../e2e/helpers/visual-fixtures';

test.skip(!hasSupabaseAdmin, 'Variables Supabase admin manquantes pour les baselines visuelles');

test.describe('Baselines visuelles — primitives Phase 1 Socle 2/2', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(visualFixedTime);
  });

  test('primitives-demo', async ({ page }) => {
    const fixture = await createVisualFixture('primitives');

    try {
      await signInToRoute(page, fixture.email, '/dev/primitives');
      await expect(page.getByTestId('primitives-demo')).toBeVisible({ timeout: 15_000 });
      await waitForFonts(page);

      await expect(page).toHaveScreenshot('primitives-demo.png', {
        fullPage: false,
      });
    } finally {
      await cleanupVisualFixture(fixture);
    }
  });
});

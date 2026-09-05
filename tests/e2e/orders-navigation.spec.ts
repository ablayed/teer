import { expect, test } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  landOnTarget,
  loginViaForm,
  waitForMerchant,
} from './helpers/auth';

for (const width of [390, 1280]) {
  test(`FIX-ORD-01 navigation ${width}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    const admin = adminClient();
    const email = e2eEmail('ord01');
    const user = await createConfirmedUser(admin, email);
    try {
      const merchant = await waitForMerchant(admin, user);
      const { error: onboardingError } = await admin
        .from('merchant_account')
        .update({ onboarded_at: new Date().toISOString() })
        .eq('id', merchant);
      if (onboardingError) throw onboardingError;
      const { data: shop, error: shopError } = await admin
        .from('shop')
        .select('id')
        .eq('merchant_account_id', merchant)
        .single();
      if (shopError) throw shopError;
      const { data: orders, error } = await admin
        .from('orders')
        .insert(
          Array.from({ length: 24 }, (_, i) => ({
            merchant_account_id: merchant,
            shop_id: shop.id,
            order_number: `FIX-ORD-${i}`,
            created_at: new Date(Date.now() - (24 - i) * 1000).toISOString(),
            total_amount: 12000,
            currency: 'XOF',
            items_summary: [{ title: 'Article test', quantity: 1, price: 12000 }],
            order_state: 'open',
            call_state: 'to_call',
            delivery_state: 'unassigned',
            cash_state: 'not_due',
          })),
        )
        .select('id');
      if (error) throw error;
      const base = `/s/${shop.id}/commandes`;
      const listPath = width === 1280 ? `${base}?vue=a-appeler&period=7j` : base;
      await page.goto(base);
      await loginViaForm(page, email, e2ePassword, listPath);
      await landOnTarget(page, listPath);
      await expect(page).toHaveURL(new URL(listPath, page.url()).href);
      const a = orders[0].id;
      const b = orders[1].id;
      const first = page.locator(`a[href="${base}/${a}"]`).first();
      await expect(first).toBeVisible();
      if (width === 1280) {
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollHeight))
          .toBeGreaterThan(1500);
      }
      await first.scrollIntoViewIfNeeded();
      await first.click({ trial: true });
      const selectedView = page.locator('button[aria-pressed="true"]');
      await expect(selectedView).toHaveCount(1);
      const selectedViews = await selectedView.allTextContents();
      await page.evaluate(() => {
        const events: unknown[] = [];
        Object.assign(window, { ord01Events: events });
        for (const method of ['focus', 'scrollIntoView'] as const) {
          const original = HTMLElement.prototype[method];
          Object.defineProperty(HTMLElement.prototype, method, {
            configurable: true,
            value: function (...args: unknown[]) {
              events.push({
                method,
                tag: this.tagName,
                id: this.id,
                cls: this.className,
                y: window.scrollY,
                height: document.documentElement.scrollHeight,
                stack: new Error().stack?.split('\n').slice(0, 6).join('\n'),
              });
              return Reflect.apply(original, this, args);
            },
          });
        }
        window.addEventListener(
          'scroll',
          () =>
            events.push({
              method: 'scroll',
              y: window.scrollY,
              height: document.documentElement.scrollHeight,
            }),
          true,
        );
      });
      const before = await page.evaluate(() => window.scrollY);
      if (width === 1280) expect(before).toBeGreaterThan(0);
      await first.click();
      await expect(page).toHaveURL(new URL(`${base}/${a}`, page.url()).href);
      await expect(
        page.getByRole('button', { name: width === 390 ? 'Retour' : 'Fermer', exact: true }),
      ).toBeVisible();
      await page.waitForTimeout(500);
      const diagnostic = await page.evaluate(() => ({
        y: window.scrollY,
        height: document.documentElement.scrollHeight,
        events: (window as unknown as { ord01Events: unknown[] }).ord01Events,
      }));
      await testInfo.attach('navigation-diagnostic', {
        body: JSON.stringify({ before, ...diagnostic }, null, 2),
        contentType: 'application/json',
      });
      if (width === 390) {
        const second = page.locator(`a[href$="/${b}"]`).first();
        // Ordinary Playwright click: verifies visibility, hit testing and absence of an overlay.
        await second.click();
        await expect(page).toHaveURL(new URL(`${base}/${b}`, page.url()).href);
        await expect(
          page.locator('main').last().getByText('FIX-ORD-1', { exact: true }),
        ).toBeVisible();
        await page.goBack();
        await expect(page).toHaveURL(new URL(`${base}/${a}`, page.url()).href);
        await expect(
          page.locator('main').last().getByText('FIX-ORD-0', { exact: true }),
        ).toBeVisible();
        await page.locator(`a[href="${base}/${b}"]`).first().click();
        await expect(page).toHaveURL(new URL(`${base}/${b}`, page.url()).href);
        await expect(
          page.locator('main').last().getByText('FIX-ORD-1', { exact: true }),
        ).toBeVisible();
        await page.goto(`${base}/${a}`);
        await page.reload();
        await expect(page).toHaveURL(new URL(`${base}/${a}`, page.url()).href);
        await expect(page.getByRole('link', { name: 'Retour', exact: true })).toBeVisible();
        await expect(
          page.locator('main').last().getByText('FIX-ORD-0', { exact: true }),
        ).toBeVisible();
      } else {
        expect(diagnostic.y).toBe(before);
        await page.getByRole('button', { name: 'Fermer', exact: true }).click();
        await expect(page).toHaveURL(new URL(listPath, page.url()).href);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
        expect(await page.locator('button[aria-pressed="true"]').allTextContents()).toEqual(
          selectedViews,
        );
      }
    } finally {
      await cleanupUsers(admin, [user]);
    }
  });
}

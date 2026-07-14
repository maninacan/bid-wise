import { test, expect } from '@playwright/test';

test('renders the homepage headline', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toContainText('Turn house plans into accurate bids');
});

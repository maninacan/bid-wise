import { test, expect } from '@playwright/test';

test('renders the sign-in screen', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
});

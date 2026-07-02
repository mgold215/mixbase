import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('landing page is public, dashboard stays gated', async ({ browser }) => {
    // Fresh context — no stored auth
    const ctx = await browser.newContext({ storageState: undefined })
    const page = await ctx.newPage()

    // '/' serves the public landing page — no redirect
    await page.goto('/')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText('ROUGH-TO-RELEASE')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Start free' }).first()).toBeVisible()

    // Protected routes still bounce to /login without a session cookie
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)

    await ctx.close()
  })

  test('dashboard loads after login (via setup)', async ({ page }) => {
    // This test uses the stored auth from global-setup
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('Your Projects')).toBeVisible()
  })
})

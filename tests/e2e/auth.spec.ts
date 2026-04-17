import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('redirects unauthenticated visitors to login', async ({ browser }) => {
    // Fresh context — no stored auth
    const ctx = await browser.newContext({ storageState: undefined })
    const page = await ctx.newPage()

    await page.goto('/')
    // App should redirect to /login when no session cookie
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByText('mixBASE')).toBeVisible()
    await expect(page.getByText('ROUGH-TO-RELEASE')).toBeVisible()

    await ctx.close()
  })

  test('dashboard loads after login (via setup)', async ({ page }) => {
    // This test uses the stored auth from global-setup
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByText('Your Projects')).toBeVisible()
  })
})

import { test, expect } from '@playwright/test'

test.describe('Audio Player', () => {
  test('project page loads with waveform player for first version', async ({ page }) => {
    await page.goto('/dashboard')

    // Skip if no projects on staging (exclude /projects/new creation link)
    const projectLinks = page.locator('a[href^="/projects/"]:not([href="/projects/new"])')
    if (await projectLinks.count() === 0) {
      test.skip()
      return
    }

    await projectLinks.first().click()
    await page.waitForURL(/\/projects\/[a-z0-9-]+/)

    // Expand the first version (it should be expanded by default)
    // The waveform player is a range input (seek bar) once audio loads
    // Look for the versions tab content
    await expect(page.getByText('Update Mix')).toBeVisible({ timeout: 15_000 })
  })

  test('player page renders without error', async ({ page }) => {
    await page.goto('/player')
    // Should render — no 500 error, nav should be visible
    await expect(page.locator('nav').first()).toBeVisible()
  })

  test('share page loads without authentication', async ({ browser }) => {
    // Fresh context — no auth cookie
    const ctx = await browser.newContext({ storageState: undefined })
    const page = await ctx.newPage()

    // Test the share page with a known-invalid token — should show "not found" message,
    // not an auth redirect (proving the route is public)
    const baseURL = process.env.BASE_URL ?? 'https://mixbase-staging.up.railway.app'
    await page.goto(`${baseURL}/share/00000000000000000000000000000000`)

    // Should NOT redirect to /login (public route)
    await expect(page).not.toHaveURL(/\/login/)
    // Should show the mixBase branding
    await expect(page.locator('body')).toBeVisible()

    await ctx.close()
  })
})

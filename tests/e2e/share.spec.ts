import { test, expect } from '@playwright/test'

test.describe('Share page (public)', () => {
  // These tests use fresh contexts — no auth required for share pages

  test('share route is public — no auth redirect for any token', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: undefined })
    const page = await ctx.newPage()
    const baseURL = process.env.BASE_URL ?? 'https://mixbase-staging.up.railway.app'

    // An invalid token should return a "not found" page, not a login redirect
    await page.goto(`${baseURL}/share/invalid000000000000000000000000`)
    await expect(page).not.toHaveURL(/\/login/)

    await ctx.close()
  })

  test('find a real share token and verify share page renders', async ({ page, request }) => {
    // Use the authenticated session to fetch a real track with a share token
    const response = await request.get('/api/tracks')

    if (!response.ok()) {
      test.skip()
      return
    }

    const tracks = await response.json()
    const trackWithToken = tracks.find((t: { share_token: string | null }) => t.share_token)

    if (!trackWithToken) {
      test.skip() // No tracks with share tokens on staging
      return
    }

    // Visit the share page in a fresh unauthenticated context
    const ctx = await page.context().browser()!.newContext({ storageState: undefined })
    const sharePage = await ctx.newPage()
    const baseURL = process.env.BASE_URL ?? 'https://mixbase-staging.up.railway.app'

    await sharePage.goto(`${baseURL}/share/${trackWithToken.share_token}`)

    // Should render the share page, not redirect to login
    await expect(sharePage).not.toHaveURL(/\/login/)

    // Share page should show the track title
    await expect(sharePage.getByText(trackWithToken.title)).toBeVisible({ timeout: 10_000 })

    // Feedback form is behind a "Leave feedback" toggle — click to expand it
    await sharePage.getByText('Leave feedback').click()
    await expect(
      sharePage.getByPlaceholder(/what do you think/i)
    ).toBeVisible({ timeout: 5_000 })

    await ctx.close()
  })
})

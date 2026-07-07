import { test as setup, expect } from '@playwright/test'
import path from 'path'

const AUTH_FILE = path.join(__dirname, '.auth.json')

// Log in once with the current multi-user email+password auth and save the
// session for all subsequent tests. Requires a real test account:
//   MIXBASE_EMAIL / MIXBASE_PASSWORD  (e.g. the review@mixbase.app account)
// The old flow filled only a single password field (the legacy shared-password
// gate); the multi-user form keeps Sign in disabled until an email is present,
// so that setup timed out and no tests ran.
setup('authenticate', async ({ page }) => {
  const email = process.env.MIXBASE_EMAIL
  const password = process.env.MIXBASE_PASSWORD
  if (!email || !password) {
    throw new Error('MIXBASE_EMAIL and MIXBASE_PASSWORD env vars are required for E2E tests')
  }

  await page.goto('/login')
  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')

  // Should land on the dashboard after login.
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  await page.context().storageState({ path: AUTH_FILE })
})

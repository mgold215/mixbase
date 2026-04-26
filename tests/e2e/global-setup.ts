import { test as setup, expect } from '@playwright/test'
import path from 'path'

const AUTH_FILE = path.join(__dirname, '.auth.json')

// Login once and save the session cookie for all subsequent tests
setup('authenticate', async ({ page }) => {
  const email = process.env.MIXBASE_EMAIL
  const password = process.env.MIXBASE_PASSWORD
  if (!email) throw new Error('MIXBASE_EMAIL env var required for E2E tests')
  if (!password) throw new Error('MIXBASE_PASSWORD env var required for E2E tests')

  await page.goto('/login')
  await expect(page.getByText('mixBASE')).toBeVisible()

  await page.fill('input[type="email"]', email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')

  // Should land on dashboard after login
  await page.waitForURL('**/dashboard', { timeout: 15_000 })
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  await page.context().storageState({ path: AUTH_FILE })
})

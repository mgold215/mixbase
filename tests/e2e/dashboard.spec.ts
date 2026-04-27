import { test, expect } from '@playwright/test'

test.describe('Dashboard', () => {
  test('renders stats bar and project grid', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText('Your Projects')).toBeVisible()

    // Stats bar has four cards — scope to the grid container to avoid matching
    // WIP/Finished badges on project cards (which appear many times in the page)
    const statsGrid = page.locator('.grid-cols-2').first()
    await expect(statsGrid.getByText('Total')).toBeVisible()
    await expect(statsGrid.getByText('WIP')).toBeVisible()
    await expect(statsGrid.getByText('Finished')).toBeVisible()
    await expect(statsGrid.getByText('Released')).toBeVisible()
  })

  test('nav shows all five sections on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/dashboard')

    // Desktop nav links — scope to the top <nav> to avoid matching project card links
    const topNav = page.locator('nav').first()
    await expect(topNav.getByRole('link', { name: 'Projects', exact: true })).toBeVisible()
    await expect(topNav.getByRole('link', { name: 'Collections', exact: true })).toBeVisible()
    await expect(topNav.getByRole('link', { name: 'Media', exact: true })).toBeVisible()
    await expect(topNav.getByRole('link', { name: 'Pipeline', exact: true })).toBeVisible()
    await expect(topNav.getByRole('link', { name: 'Player', exact: true })).toBeVisible()
  })

  test('new project button is present', async ({ page }) => {
    await page.goto('/dashboard')
    // The "New Project" or "New" button should exist
    const newBtn = page.getByRole('link', { name: /new/i })
    await expect(newBtn).toBeVisible()
  })

  test('clicking a project card navigates to project page', async ({ page }) => {
    await page.goto('/dashboard')

    // If there are projects, click the first card to navigate (exclude /projects/new creation link)
    const projectLinks = page.locator('a[href^="/projects/"]:not([href="/projects/new"])')
    const count = await projectLinks.count()
    if (count === 0) {
      test.skip() // Skip if no projects exist on staging yet
      return
    }

    await projectLinks.first().click()
    await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+/)
  })
})

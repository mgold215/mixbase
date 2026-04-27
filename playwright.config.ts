import { defineConfig, devices } from '@playwright/test'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

// Load secrets from the project .env symlink (→ ~/.env.secrets) if env vars aren't already set
const envFile = path.join(__dirname, '.env')
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=["']?(.+?)["']?\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

// Run against staging by default; override with BASE_URL env var for local testing
const BASE_URL = process.env.BASE_URL ?? 'https://mixbase-staging.up.railway.app'

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 1,
  workers: 1, // Run sequentially — tests share login state

  use: {
    baseURL: BASE_URL,
    // Store auth cookie across tests in this file
    storageState: 'tests/e2e/.auth.json',
    // Headless by default; set HEADED=1 env var to see the browser
    headless: process.env.HEADED !== '1',
  },

  projects: [
    // Setup: login once and save cookie
    {
      name: 'setup',
      testMatch: /global-setup\.ts/,
      use: { storageState: undefined }, // No stored auth during setup
    },
    // All tests depend on the login setup
    {
      name: 'chromium',
      use: devices['Desktop Chrome'],
      dependencies: ['setup'],
    },
  ],
})

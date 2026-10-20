import { defineConfig, devices } from '@playwright/test'
import {
  deterministicEnvironment,
  fixtureOrigin,
  fixturePort,
} from './scripts/lib/browser-environment.mjs'

const appPort = Number(process.env.PLAYWRIGHT_APP_PORT ?? 3100)
const appOrigin = `http://127.0.0.1:${appPort}`

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  globalTeardown: './test/browser/global-teardown.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: appOrigin,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `node test/browser/fail-fast-service.mjs --port ${fixturePort}`,
      url: `${fixtureOrigin}/health`,
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: 'npm run start',
      url: `${appOrigin}/create`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: deterministicEnvironment(appPort),
    },
  ],
})

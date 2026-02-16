import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const labnoteTestDataDir = path.join(process.cwd(), '.labnote-test-data')

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    acceptDownloads: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    env: {
      ...process.env,
      LABNOTE_DATA_DIR: labnoteTestDataDir,
    },
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile-pair\.spec\.ts/,
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile-pair\.spec\.ts/,
    },
  ],
})

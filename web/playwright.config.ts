import { defineConfig, devices } from '@playwright/test'

const frontendPort = Number(process.env.E2E_PORT ?? 4173)
const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 3300)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: [
    {
      command: 'bash e2e/backend-server.sh',
      port: backendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
      env: {
        E2E_BACKEND_PORT: String(backendPort),
        E2E_RESET_DB: '1',
      },
    },
    {
      command: `node_modules/.bin/rsbuild dev --port ${frontendPort} --strict-port`,
      port: frontendPort,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        VITE_REACT_APP_SERVER_URL: `http://127.0.0.1:${backendPort}`,
      },
    },
  ],
})

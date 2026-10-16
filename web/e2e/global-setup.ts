import { expect, request } from '@playwright/test'

import { E2E_PASSWORD, E2E_USERNAME } from './support/auth'

const backendPort = Number(process.env.E2E_BACKEND_PORT ?? 3300)
const backendURL = `http://127.0.0.1:${backendPort}`

// Refresh tokens rotate on first use, so a stored browser state cannot be
// shared between tests. Each test signs in through the UI instead; this setup
// only makes sure the instance has a root account to sign in with.
export default async function globalSetup() {
  const context = await request.newContext()
  try {
    const statusResponse = await context.get(`${backendURL}/api/setup`)
    expect(statusResponse.ok()).toBe(true)
    const status = await statusResponse.json()

    if (!status?.data?.status) {
      const setupResponse = await context.post(`${backendURL}/api/setup`, {
        data: {
          username: E2E_USERNAME,
          password: E2E_PASSWORD,
          confirmPassword: E2E_PASSWORD,
          SelfUseModeEnabled: false,
          DemoSiteEnabled: false,
        },
      })
      expect(setupResponse.ok()).toBe(true)
      expect(await setupResponse.json()).toMatchObject({ success: true })
    }
  } finally {
    await context.dispose()
  }
}

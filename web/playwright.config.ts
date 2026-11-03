import { defineConfig } from '@playwright/test'

// Each test file starts its own minbox (see e2e/fixtures.ts) with a fake
// `claude`, so the tests need no model and no network.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    viewport: { width: 1500, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
})

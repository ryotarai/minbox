import { defineConfig } from '@playwright/test'

// Each test file starts its own minbox (see e2e/fixtures.ts) with a fake
// `claude`, so the tests need no model and no network.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Every test starts its own minbox on a free port with its own data dir, so tests are independent
  // and can run in parallel, even tests of one file. Override with `--workers=N` (or PW_WORKERS=N);
  // above ~10 on a laptop the browsers starve each other and timing-sensitive tests turn flaky.
  fullyParallel: true,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 8,
  reporter: [['list']],
  use: {
    viewport: { width: 1500, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
})

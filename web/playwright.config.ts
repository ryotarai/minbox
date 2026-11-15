import { defineConfig } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Claude Code's config is never the person's own in the tests: minbox marks the folders of Claude
// Code sessions trusted in $CLAUDE_CONFIG_DIR/.claude.json (else ~/.claude.json), so every minbox,
// terminal host and fake claude the tests start gets a throwaway CLAUDE_CONFIG_DIR. Set once in the
// runner; the workers inherit it. real-claude.spec.ts puts the original back for the real Claude Code.
if (!process.env.MINBOX_E2E_CLAUDE_CONFIG_DIR) {
  process.env.MINBOX_E2E_REAL_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? ''
  process.env.MINBOX_E2E_CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'minbox-e2e-claude-'))
}
process.env.CLAUDE_CONFIG_DIR = process.env.MINBOX_E2E_CLAUDE_CONFIG_DIR

// Each test file starts its own minbox (see e2e/fixtures.ts) with a fake
// `claude`, so the tests need no model and no network.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Every test starts its own minbox on a free port with its own data dir, so tests are independent
  // and can run in parallel, even tests of one file. Override with `--workers=N` (or PW_WORKERS=N);
  // above ~8 on a laptop the browsers starve each other and timing-sensitive tests turn flaky.
  fullyParallel: true,
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 6,
  reporter: [['list']],
  use: {
    viewport: { width: 1500, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
})

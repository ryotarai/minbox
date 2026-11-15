import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from './fixtures'

// minbox marks the folder of a Claude Code session trusted in Claude Code's config before it starts
// (so the fake claude here would not stop at a trust dialog). Each minbox of the tests has its own
// CLAUDE_CONFIG_DIR; the person's ~/.claude.json is never involved.

function trusted(cfg: string, dir: string): boolean {
  try {
    return JSON.parse(readFileSync(cfg, 'utf8')).projects?.[dir]?.hasTrustDialogAccepted === true
  } catch {
    return false
  }
}

test('a Claude Code session folder is marked trusted in its CLAUDE_CONFIG_DIR; the setting turns it off', async ({ page, minbox }) => {
  expect(process.env.CLAUDE_CONFIG_DIR, 'the runner has a throwaway CLAUDE_CONFIG_DIR').toBeTruthy()
  expect(resolve(process.env.CLAUDE_CONFIG_DIR!)).not.toBe(resolve(homedir(), '.claude'))
  const cfg = join(minbox.claudeConfigDir, '.claude.json')
  writeFileSync(cfg, JSON.stringify({ numStartups: 7, projects: {} }, null, 2), { mode: 0o600 })

  const work = realpathSync(mkdtempSync(join(minbox.dataDir, 'work-')))
  const r = await fetch(minbox.url + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: work, name: 'trusty' }) })
  expect(r.status).toBe(201)
  await expect.poll(() => trusted(cfg, work)).toBe(true)
  expect(JSON.parse(readFileSync(cfg, 'utf8')).numStartups).toBe(7)

  // Settings › Capabilities: the switch (on by default) turns it off.
  await page.goto(minbox.url + '/#v=settings&ss=capabilities')
  const sw = page.getByRole('switch', { name: 'Trust folders Claude starts in' })
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await sw.click()
  await expect.poll(async () => (await (await fetch(minbox.url + '/api/settings')).json()).claude_trust_folders).toBe(false)

  const other = realpathSync(mkdtempSync(join(minbox.dataDir, 'work-')))
  const r2 = await fetch(minbox.url + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: other, name: 'untrusted' }) })
  expect(r2.status).toBe(201)
  await page.waitForTimeout(500)
  expect(trusted(cfg, other)).toBe(false)
})

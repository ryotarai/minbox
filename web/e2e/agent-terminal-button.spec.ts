import { createSession, expect, expectTerminal, test } from './fixtures'
import type { Page } from '@playwright/test'

// The thread header's agent-terminal button shows the session's agent (Claude Code, OpenCode, Pi), so
// it reads apart from the shell button (>_) next to it. Set MINBOX_SHOT_DIR to save a picture of the header.

const shotDir = process.env.MINBOX_SHOT_DIR
if (shotDir) test.use({ deviceScaleFactor: 3 })

async function shootHeader(page: Page, name: string) {
  if (!shotDir) return
  const toggle = page.getByTestId('terminal-toggle')
  const shell = page.getByTestId('shell-toggle')
  const a = (await toggle.boundingBox())!
  const b = (await shell.boundingBox())!
  const x = Math.min(a.x, b.x) - 200
  const y = Math.min(a.y, b.y) - 10
  await page.screenshot({ path: `${shotDir}/${name}`, clip: { x: Math.max(0, x), y: Math.max(0, y), width: 300, height: 52 } })
}

const cases = [
  { agent: 'claude', label: 'Claude Code' },
  { agent: 'opencode', label: 'OpenCode' },
  { agent: 'pi', label: 'Pi' },
] as const

for (const c of cases) {
  test(`desktop: the agent-terminal button names and shows ${c.label}`, async ({ page, allAgentsMinbox }) => {
    await page.goto(allAgentsMinbox.url)
    await createSession(page, allAgentsMinbox.dataDir, `${c.agent}-s`, c.agent)
    await expectTerminal(page, 'ready>')
    await page.evaluate(() => localStorage.removeItem('minbox:layout'))
    await page.reload()

    const toggle = page.getByTestId('terminal-toggle')
    await expect(toggle).toHaveAttribute('data-agent', c.agent)
    await expect(toggle).toHaveAttribute('aria-label', `Show ${c.label} terminal`)
    await expect(toggle).toHaveAttribute('title', `Show the ${c.label} terminal`)
    // The shell button stays as it is, a different icon.
    const shell = page.getByTestId('shell-toggle')
    await expect(shell).toHaveAttribute('aria-label', 'Open shell')
    expect(await toggle.locator('svg').innerHTML()).not.toBe(await shell.locator('svg').innerHTML())
    await shootHeader(page, `agent-icon-${c.agent}.png`)

    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-label', `Hide ${c.label} terminal`)
    await expect(toggle).toHaveAttribute('title', `Hide the ${c.label} terminal`)
  })
}

test('desktop: the default fake agent is Claude Code', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'plain')
  await expectTerminal(page, 'ready>')
  await page.evaluate(() => localStorage.removeItem('minbox:layout'))
  await page.reload()
  const toggle = page.getByTestId('terminal-toggle')
  await expect(toggle).toHaveAttribute('aria-label', 'Show Claude Code terminal')
  await shootHeader(page, 'agent-icon.png')
})

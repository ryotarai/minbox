import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, expectTerminal, test, typeInTerminal } from './fixtures'
import { startAgent } from './v3'

// Commands an agent asks the person to run (send_message `commands`, docs/agent-commands.md): the
// message shows a card with Allow / Deny; an allowed command runs on the agent's host, the card shows
// its exit code and output, and the agent gets the results as a message from minbox.

const SHOTS = process.env.RUN_COMMANDS_SHOTS ?? ''

async function snap(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png'), fullPage: false })
}

test('an agent asks to run commands: Allow runs one, Deny skips one, the results reach the agent', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'cmdr')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, `cmds [{"command": "echo hello-from-allow; echo to-stderr >&2", "description": "Say hello"}, {"command": "echo nope > never.txt", "description": "Should be denied"}]`)
  await expectTerminal(page, /commands sent msg_/)

  const card = page.getByTestId('run-commands')
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute('data-state', 'Waiting')
  const rows = card.getByTestId('run-command')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0).getByTestId('run-command-line')).toContainText('$ echo hello-from-allow; echo to-stderr >&2')
  await expect(rows.nth(0)).toContainText('Say hello')
  await expect(rows.nth(0).getByTestId('run-command-cwd')).toContainText(join(minbox.dataDir, 'proj'))
  await expect(card.getByTestId('run-commands-allow-all')).toBeVisible()
  await expect(card.getByTestId('run-commands-deny-all')).toBeVisible()
  // The commands are what the person answers first: no reply help meanwhile.
  await expect(page.locator('[data-reply-help]')).toHaveCount(0)
  await snap(page, 'run-commands-desktop-pending')

  await rows.nth(1).getByTestId('run-command-deny').click()
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'denied')
  await expect(rows.nth(1).getByTestId('run-command-status')).toContainText('Denied')
  // One left: no "all" buttons, the row's own Allow.
  await expect(card.getByTestId('run-commands-allow-all')).toHaveCount(0)
  await rows.nth(0).getByTestId('run-command-allow').click()
  await expect(rows.nth(0)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
  await expect(rows.nth(0).getByTestId('run-command-status')).toContainText('Exit 0')
  await expect(rows.nth(0).getByTestId('run-command-output')).toHaveCount(0)
  await rows.nth(0).getByTestId('run-command-toggle').click()
  await expect(rows.nth(0).getByTestId('run-command-output')).toContainText('hello-from-allow')
  await expect(rows.nth(0).getByTestId('run-command-output')).toContainText('to-stderr')
  await expect(card.getByTestId('run-commands-reported')).toBeVisible()
  await expect(page.locator('[data-testid="v3-message"][data-kind="run_result"]')).toHaveCount(1)
  expect(existsSync(join(minbox.dataDir, 'proj', 'never.txt'))).toBe(false)
  // The agent gets them as a message from minbox, in Markdown with the output.
  await expectTerminal(page, /<<< inbox[\s\S]*the person decided on the commands you asked to run[\s\S]*1 ran, 1 denied[\s\S]*hello-from-allow[\s\S]*denied by the person/)
  await snap(page, 'run-commands-desktop-done')

  // Still there after a reload; nothing to decide any more.
  await page.reload()
  await expect(card.getByTestId('run-command')).toHaveCount(2)
  await expect(card.getByTestId('run-command-allow')).toHaveCount(0)
  await expect(card).toHaveAttribute('data-state', 'Done')
})

test('phone: Allow all runs every command in order and the card fits the screen', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'cmdp')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expectTerminal(page, 'ready>')
  const long = 'echo ' + 'a-very-long-argument-'.repeat(8)
  await typeInTerminal(page, `cmds [{"command": "echo one > order.txt", "description": "First"}, {"command": "cat order.txt; exit 2", "description": "Second fails"}, {"command": "${long}"}]`)
  await expectTerminal(page, /commands sent msg_/)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const card = page.getByTestId('run-commands')
  await expect(card).toBeVisible()
  await card.scrollIntoViewIfNeeded()
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
  const box = await card.boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  const allow = await card.getByTestId('run-commands-allow-all').boundingBox()
  expect(allow!.height).toBeGreaterThanOrEqual(40)
  await snap(page, 'run-commands-phone-pending')
  await card.getByTestId('run-commands-allow-all').click()
  const rows = card.getByTestId('run-command')
  await expect(rows.nth(2)).toHaveAttribute('data-state', 'done', { timeout: 15_000 })
  await expect(rows.nth(0).getByTestId('run-command-status')).toContainText('Exit 0')
  // A failure does not stop the rest; the second saw the first's file.
  await expect(rows.nth(1).getByTestId('run-command-status')).toContainText('Exit 2')
  await rows.nth(1).getByTestId('run-command-toggle').click()
  await expect(rows.nth(1).getByTestId('run-command-output')).toContainText('one')
  await expect(card.getByTestId('run-commands-reported')).toBeVisible()
  await snap(page, 'run-commands-phone-done')
})

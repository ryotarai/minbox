import type { Page } from '@playwright/test'
import { expect, expectTerminal, test, type Minbox } from './fixtures'
import { startAgent } from './v3'

// v3 (ported from thread-commands.spec.ts): "!" in an agent stream's reply box.

// "!" in a reply runs a shell command in the session's folder (docs/thread-commands.md). The
// result is a message in the thread; when the command ends, minbox sends it to the agent at once
// (with the lines written below the command, or a short follow-up), so the agent starts a turn.

async function openThread(page: Page, m: Minbox, agent?: 'claude' | 'pi' | 'opencode') {
  const a = await startAgent(m, 'alpha', 'cproj', agent ? { agent } : {})
  await page.goto(`${m.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('composer-text')).toBeVisible()
  return a
}

async function walk(page: Page, dir: string, phone: boolean) {
  const box = page.getByTestId('composer-text')

  // The hint shows while the text starts with "!", not for an escaped or a plain message.
  await box.fill('!echo hi; echo oops >&2; pwd')
  await expect(page.getByTestId('command-hint')).toContainText(`Runs as a command in ${dir}`)
  await box.fill('\\!echo hi')
  await expect(page.getByTestId('command-hint')).toHaveCount(0)
  await box.fill('!echo hi; echo oops >&2; pwd')
  await expect(page.getByTestId('composer-send')).toHaveText('Run')
  await page.getByTestId('composer-send').click()

  const block = page.locator('[data-testid="message"][data-kind="command"]')
  await expect(block).toHaveCount(1)
  await expect(block.getByTestId('command-line')).toContainText('$ echo hi; echo oops >&2; pwd')
  await expect(block.getByTestId('command-output')).toContainText('hi')
  await expect(block.getByTestId('command-output')).toContainText('oops')
  await expect(block.getByTestId('command-output')).toContainText(dir.split('/').pop()!)
  await expect(block.getByTestId('command-status')).toContainText('Exit 0')
  await expect(box).toHaveValue('')
  // Nothing more to send: minbox sends the result with a follow-up, and the agent gets it.
  if (!phone) await expectTerminal(page, /<<< inbox \[[^\]]*\] <minbox_user_command[\s\S]*\$ echo hi[\s\S]*I ran the command above myself/)
  await expect(block).toContainText('Agent has the result')

  // A failing command with words below it: the words go to the agent with the result.
  await box.fill('!seq 1 40; exit 7\nwhy did it fail?')
  await page.getByTestId('composer-send').click()
  const second = block.filter({ hasText: 'seq 1 40' })
  await expect(second.getByTestId('command-line')).not.toContainText('why did it fail')
  await expect(second.getByTestId('command-status')).toContainText('Exit 7')
  await expect(second.getByTestId('command-toggle')).toHaveText('Show all 40 lines')
  await expect(second.getByTestId('command-output')).not.toContainText('40')
  await second.getByTestId('command-toggle').click()
  await expect(second.getByTestId('command-output')).toContainText('40')
  if (!phone) await expectTerminal(page, /<<< inbox \[[^\]]*\] <minbox_user_command[\s\S]*\$ seq 1 40; exit 7[\s\S]*exit code 7[\s\S]*why did it fail\?/)
  await expect(second).toContainText('Agent has the result')
  await expect(page.getByTestId('stream-view')).toContainText('why did it fail?')

  // Still there after a reload.
  await page.reload()
  await expect(block.last().getByTestId('command-status')).toContainText('Exit 7')
  await expect(block.last()).toContainText('Agent has the result')

  // "\!" sends the text as a normal message.
  await box.fill('\\!bang')
  await page.getByTestId('composer-send').click()
  if (!phone) await expectTerminal(page, /<<< inbox \[[^\]]*\] !bang/)
  await expect(page.getByTestId('stream-view')).toContainText('!bang')
}

test('! runs a command in the stream (desktop)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await openThread(page, minbox)
  await walk(page, minbox.dataDir + '/cproj', false)
})

test('! runs a command in the stream (phone, dark theme)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  const a = await openThread(page, minbox)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await walk(page, minbox.dataDir + '/cproj', true)
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
})

for (const agent of ['pi', 'opencode'] as const) {
  test(`! sends the result to the agent when the command ends (${agent})`, async ({ page, allAgentsMinbox: minbox }) => {
    await page.goto(minbox.url)
    await openThread(page, minbox, agent)
    await page.getByTestId('composer-text').fill('!echo from-' + agent + '\nthanks, go on')
    await page.getByTestId('composer-send').click()
    await expectTerminal(page, new RegExp(`<<< inbox \\[[^\\]]*\\] <minbox_user_command[\\s\\S]*from-${agent}[\\s\\S]*thanks, go on`))
    await expect(page.locator('[data-testid="message"][data-kind="command"]')).toContainText('Agent has the result')
  })
}

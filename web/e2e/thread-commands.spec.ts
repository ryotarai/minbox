import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// "!" in a reply runs a shell command in the session's folder (docs/thread-commands.md). The
// result is a message in the thread and rides along with the agent's next delivered message.

async function openThread(page: Page, dir: string) {
  await createSession(page, dir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
}

async function walk(page: Page, dir: string, phone: boolean) {
  const box = page.getByTestId('reply-box')

  // The hint shows while the text starts with "!", not for an escaped or a plain message.
  await box.fill('!echo hi; echo oops >&2; pwd')
  await expect(page.getByTestId('command-hint')).toContainText(`Runs as a command in ${dir}`)
  await box.fill('\\!echo hi')
  await expect(page.getByTestId('command-hint')).toHaveCount(0)
  await box.fill('!echo hi; echo oops >&2; pwd')
  await page.getByTestId('reply-send').click()

  const block = page.locator('[data-testid="message"][data-kind="command"]')
  await expect(block).toHaveCount(1)
  await expect(block.getByTestId('command-line')).toContainText('$ echo hi; echo oops >&2; pwd')
  await expect(block.getByTestId('command-output')).toContainText('hi')
  await expect(block.getByTestId('command-output')).toContainText('oops')
  await expect(block.getByTestId('command-output')).toContainText(dir.split('/').pop()!)
  await expect(block.getByTestId('command-status')).toContainText('Exit 0')
  await expect(block).toContainText('Agent gets it with your next message')
  await expect(box).toHaveValue('')

  // A failing command, and long output collapsed.
  await box.fill('!seq 1 40; exit 7')
  await page.getByTestId('reply-send').click()
  const second = block.nth(1)
  await expect(second.getByTestId('command-status')).toContainText('Exit 7')
  await expect(second.getByTestId('command-toggle')).toHaveText('Show all 40 lines')
  await expect(second.getByTestId('command-output')).not.toContainText('40')
  await second.getByTestId('command-toggle').click()
  await expect(second.getByTestId('command-output')).toContainText('40')

  // Still there after a reload.
  await page.reload()
  if (phone) {
    // The phone may come back on the list or on the thread.
    const view = page.getByTestId('thread-view')
    const row = page.getByTestId('thread-row').filter({ hasText: 'Pick a database' })
    await expect(view.or(row).first()).toBeVisible()
    if (!(await view.isVisible())) await row.click()
  }
  await expect(block).toHaveCount(2)
  await expect(block.first().getByTestId('command-status')).toContainText('Exit 0')

  // Nothing went to the agent yet; the next message carries both results, once.
  await box.fill('go on')
  await page.getByTestId('reply-send').click()
  if (!phone) await expectTerminal(page, /<<< inbox \[Pick a database\] <minbox_user_command[\s\S]*\$ echo hi[\s\S]*go on/)
  await expect(block.first()).toContainText('Agent has the result')

  // "\!" sends the text as a normal message.
  await box.fill('\\!bang')
  await page.getByTestId('reply-send').click()
  if (!phone) await expectTerminal(page, /<<< inbox \[Pick a database\] !bang/)
  await expect(page.getByTestId('thread-view')).toContainText('!bang')
}

test('! runs a command in the thread (desktop)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await openThread(page, minbox.dataDir)
  await walk(page, minbox.dataDir, false)
})

test('! runs a command in the thread (phone, dark theme)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await openThread(page, minbox.dataDir)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await walk(page, minbox.dataDir, true)
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
})

import { basename } from 'node:path'
import { createSession, expect, expectTerminal, terminalText, test } from './fixtures'
import type { Page } from '@playwright/test'

// A Claude Code session has a companion shell: a pane at the far right (desktop) or a full-screen
// overlay (phone), in the session's folder. Hiding it leaves the shell running.

async function typeInShell(page: Page, text: string) {
  await page.getByTestId('shell-pane').getByTestId('terminal').click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

async function expectShell(page: Page, text: string) {
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).toContain(text)
}

test('desktop: the shell pane is hidden, opens by button and Ctrl+`, runs in the cwd and keeps its scrollback', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'work')
  await expectTerminal(page, 'ready>')
  await expect(page.getByTestId('shell-pane')).toHaveCount(0)

  await page.getByTestId('shell-toggle').click()
  await expect(page.getByTestId('shell-pane')).toBeVisible()
  await expect(page.getByTestId('shell-toggle')).toHaveAttribute('aria-pressed', 'true')
  await typeInShell(page, 'echo before-$((6*7)); pwd')
  await expectShell(page, 'before-42')
  await expectShell(page, basename(minbox.dataDir))
  expect(await terminalText(page, 'shell')).toMatch(new RegExp('/' + basename(minbox.dataDir)))

  // Hide with the button: the shell goes on; the session terminal is untouched.
  await page.getByTestId('shell-toggle').click()
  await expect(page.getByTestId('shell-pane')).toHaveCount(0)
  await expectTerminal(page, 'ready>')

  // Show with the shortcut: same shell, scrollback and focus.
  await page.keyboard.press('Control+`')
  await expect(page.getByTestId('shell-pane')).toBeVisible()
  await expectShell(page, 'before-42')
  await page.keyboard.type('echo after-$((7*7))')
  await page.keyboard.press('Enter')
  await expectShell(page, 'after-49')

  // The shortcut also closes it while the shell has the focus.
  await page.keyboard.press('Control+`')
  await expect(page.getByTestId('shell-pane')).toHaveCount(0)

  // The close button of the pane.
  await page.keyboard.press('Control+`')
  await page.getByTestId('shell-close').click()
  await expect(page.getByTestId('shell-pane')).toHaveCount(0)

  // It is not a session.
  await expect(page.getByTestId('session-row')).toHaveCount(1)
})

test('desktop: no shell pane or button for a shell session', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'plain', 'shell')
  await expect(page.getByTestId('shell-toggle')).toHaveCount(0)
  await page.getByTestId('terminal').click()
  await page.keyboard.press('Control+`')
  await expect(page.getByTestId('shell-pane')).toHaveCount(0)
})

for (const width of [1500, 1920]) {
  test(`desktop: nothing overflows with the shell pane at ${width}px`, async ({ page, minbox }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'work')
    await expectTerminal(page, 'ready>')
    await page.getByTestId('shell-toggle').click()
    await expect(page.getByTestId('shell-pane')).toBeVisible()
    const m = await page.evaluate(() => {
      const r = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()
      return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, shell: r('shell-pane'), main: document.querySelector('main')!.getBoundingClientRect() }
    })
    expect(m.scroll).toBeLessThanOrEqual(m.inner)
    expect(m.shell.right).toBeLessThanOrEqual(m.inner + 0.5)
    expect(m.shell.width).toBeGreaterThanOrEqual(270)
    expect(m.main.width).toBeGreaterThanOrEqual(400)
    expect(m.main.right).toBeLessThanOrEqual(m.shell.left + 0.5)
  })
}

test('phone: the shell opens full screen, closes, and reopens with its scrollback', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pocket')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('session-row').filter({ hasText: 'pocket' }).click()
  await expect(page.getByTestId('phone-shell')).toHaveCount(0)

  await page.getByTestId('shell-toggle').click()
  const overlay = page.getByTestId('phone-shell')
  await expect(overlay).toBeVisible()
  await expect(overlay.getByTestId('term-key-esc')).toBeVisible()
  await overlay.getByTestId('terminal').click()
  await page.keyboard.type('echo phone-$((6*7))')
  await page.keyboard.press('Enter')
  await expectShell(page, 'phone-42')

  await overlay.getByTestId('shell-close').click()
  await expect(overlay).toHaveCount(0)

  await page.getByTestId('shell-toggle').click()
  await expect(page.getByTestId('phone-shell')).toBeVisible()
  await expectShell(page, 'phone-42')
})

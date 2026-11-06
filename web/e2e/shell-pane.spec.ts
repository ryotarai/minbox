import { basename } from 'node:path'
import { createSession, createShellSession, expect, expectTerminal, phoneSelectSession, terminalText, test, typeInTerminal } from './fixtures'
import type { Page } from '@playwright/test'

// A Claude Code session has a companion shell: a pane at the far right (desktop) or a full-screen
// overlay (phone), in the session's folder. Hiding it leaves the shell running.

async function typeInShell(page: Page, text: string) {
  // A login shell drops what is typed before its line editor starts (slow on a busy machine): wait
  // for its prompt, and for the screen to stop changing.
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).toMatch(/\S/)
  let last = ''
  await expect
    .poll(async () => {
      const now = await terminalText(page, 'shell')
      const same = now === last
      last = now
      return same
    }, { intervals: [300] })
    .toBe(true)
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
  expect(await (await page.request.get(minbox.url + '/api/sessions')).json()).toHaveLength(1)
})

test('desktop: no shell pane or button for a shell session', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createShellSession(page, minbox, 'plain')
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
    expect(m.main.width).toBeGreaterThanOrEqual(340)
    expect(m.main.right).toBeLessThanOrEqual(m.shell.left + 0.5)
  })
}

test('phone: the shell opens full screen, closes, and reopens with its scrollback', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pocket')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await phoneSelectSession(page, 'pocket', 'terminal')
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

test('phone and tablet: the thread menu opens the shell without going to the terminal first', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'menu')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Hello thread')
  await expectTerminal(page, /sent .*thr_/)
  for (const width of [390, 900]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(minbox.url + '/#')
    if (width === 390) await phoneSelectSession(page, 'menu')
    await page.getByTestId('thread-row').first().click()
    await page.getByTestId('thread-more').first().click()
    await page.getByTestId('thread-open-shell').click()
    await expect(page.getByTestId('phone-shell')).toBeVisible()
    await page.getByTestId('shell-close').click()
    await expect(page.getByTestId('phone-shell')).toHaveCount(0)
  }
})

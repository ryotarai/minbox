import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// ⌘K quick actions: one list of actions, sessions and threads, narrowed as you type.

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const items = (page: Page) => page.getByTestId('palette-item')

async function openPalette(page: Page) {
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('palette')).toBeVisible()
  await expect(page.getByTestId('palette-input')).toBeFocused()
}

/** Two sessions, a thread in each ("Pick a database" in alpha, "Archive rules" in beta). */
async function setup(page: Page, minbox: { url: string; dataDir: string }) {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Pick a database' })).toBeVisible()
  await createSession(page, minbox.dataDir, 'beta')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'stop')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Archive rules' })).toBeVisible()
}

test('type to find a session; Enter opens it and focuses its terminal; ⌘K again closes', async ({ page, minbox }) => {
  await setup(page, minbox)
  await openPalette(page)
  await page.getByTestId('palette-input').fill('alp')
  await expect(items(page).first()).toHaveAttribute('data-kind', 'session')
  await expect(items(page).first()).toContainText('alpha')
  await expect(items(page).first().locator('mark')).toHaveText('alp')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('palette')).toHaveCount(0)
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await typeInTerminal(page, 'say hello')
  await expectTerminal(page, 'sent in')

  await openPalette(page)
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('palette')).toHaveCount(0)
})

test('a thread is found by subject or session name, and opens in its session', async ({ page, minbox }) => {
  await setup(page, minbox)
  // beta is the current session; the database thread lives in alpha.
  await openPalette(page)
  await page.getByTestId('palette-input').fill('pckdb')
  const row = items(page).first()
  await expect(row).toHaveAttribute('data-kind', 'thread')
  await expect(row).toContainText('Pick a database')
  await expect(row).toContainText('alpha')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')

  // The session name finds its threads too, and a waiting thread says so.
  await openPalette(page)
  await page.getByTestId('palette-input').fill('beta rules')
  await expect(items(page).first()).toContainText('Archive rules')
  await expect(items(page).first().getByTestId('palette-waiting')).toBeVisible()
})

test('> shows only actions; New session opens the dialog; # and @ filter threads and sessions', async ({ page, minbox }) => {
  await setup(page, minbox)
  await openPalette(page)
  await page.getByTestId('palette-input').fill('>')
  await expect(items(page).first()).toHaveAttribute('data-kind', 'action')
  expect(await items(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'action'))).toBe(true)
  await page.getByTestId('palette-input').fill('>new sess')
  await expect(items(page).first()).toHaveAttribute('data-id', 'new-session')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('new-session-cwd')).toBeVisible()
  await page.keyboard.press('Escape')

  await openPalette(page)
  await page.getByTestId('palette-input').fill('#')
  await expect(items(page)).toHaveCount(2)
  expect(await items(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'thread'))).toBe(true)
  await page.getByTestId('palette-input').fill('@')
  await expect(items(page)).toHaveCount(2)
  expect(await items(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'session'))).toBe(true)
  await expect(page.getByTestId('palette-hint')).toBeVisible()
})

test('arrows and Ctrl+N/P move, Enter on no result does nothing, Esc closes without reaching the terminal', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'esc', 'shell')
  await typeInTerminal(page, 'echo first')
  await expectTerminal(page, /^first$/m)
  await page.keyboard.type('echo kept')

  await openPalette(page)
  await page.getByTestId('palette-input').fill('@')
  const sel = () => page.locator('[data-testid="palette-item"][data-selected="true"]')
  await expect(sel()).toHaveCount(1)
  await page.getByTestId('palette-input').fill('>')
  await expect(sel()).toHaveAttribute('data-id', 'new-session')
  await page.keyboard.press('ArrowDown')
  const second = await sel().getAttribute('data-id')
  expect(second).not.toBe('new-session')
  await page.keyboard.press('Control+n')
  const third = await sel().getAttribute('data-id')
  expect(third).not.toBe(second)
  await page.keyboard.press('Control+p')
  await expect(sel()).toHaveAttribute('data-id', second!)
  await page.keyboard.press('ArrowUp')
  await expect(sel()).toHaveAttribute('data-id', 'new-session')

  await page.getByTestId('palette-input').fill('zzzqqqxxx')
  await expect(items(page)).toHaveCount(0)
  await expect(page.getByTestId('palette-empty')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('palette')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toHaveCount(0)
  // The ESC stayed here: the line typed before is still intact and runs.
  await page.getByTestId('terminal').click()
  await page.keyboard.press('Enter')
  await expectTerminal(page, /^kept$/m)
  expect(await terminalText(page)).not.toContain('^[')
})

test('with an empty query, what was opened last comes first as Recent', async ({ page, minbox }) => {
  await setup(page, minbox)
  await openPalette(page)
  await expect(page.getByText('Recent', { exact: true })).toHaveCount(0)
  await page.getByTestId('palette-input').fill('#pick')
  await expect(items(page).first()).toContainText('Pick a database')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')

  await openPalette(page)
  await expect(page.getByText('Recent', { exact: true })).toBeVisible()
  await expect(items(page).first()).toHaveAttribute('data-kind', 'thread')
  await expect(items(page).first()).toContainText('Pick a database')
  // After Recent come the actions, then the sessions.
  const kinds = await items(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  expect(kinds.indexOf('action')).toBe(1)
  expect(kinds.lastIndexOf('session')).toBeGreaterThan(kinds.lastIndexOf('action'))
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('minbox:recent') ?? '[]'))).toHaveLength(1)
})

test('⌘K works from inside the focused terminal and a text box; actions act', async ({ page, minbox }) => {
  await setup(page, minbox)
  await page.getByTestId('terminal').click()
  await openPalette(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toHaveCount(0)

  await page.getByTestId('quick-body').click()
  await openPalette(page)
  await page.getByTestId('palette-input').fill('>shortcuts')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('shortcuts')).toBeVisible()
  await page.keyboard.press('Escape')

  await openPalette(page)
  await page.getByTestId('palette-input').fill('>settings')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/v=settings/)

  await page.goto(minbox.url + '/#')
  await page.reload()
  await expectTerminal(page, 'ready>')
  await openPalette(page)
  await page.getByTestId('palette-input').fill('>shell pane')
  await expect(items(page).first()).toHaveAttribute('data-id', 'shell-pane')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('shell-pane')).toBeVisible()
  // Let the shell connect (it takes focus when it does) before the next palette.
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).not.toBe('')
  await page.waitForTimeout(300)

  await openPalette(page)
  await page.getByTestId('palette-input').fill('>open all inbox')
  await expect(items(page).first()).toHaveAttribute('data-id', 'inbox')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('all-inbox')).toBeVisible()
})

test('a click on a row runs it', async ({ page, minbox }) => {
  await setup(page, minbox)
  await openPalette(page)
  await page.getByTestId('palette-input').fill('@alpha')
  await items(page).first().click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
})

test('phone: the entry button opens a full-width sheet; a thread opens from it', async ({ page, minbox }) => {
  await setup(page, minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toBeVisible()
  await page.getByTestId('open-palette').click()
  const dialog = page.getByRole('dialog', { name: 'Quick actions' })
  await expect(dialog).toBeVisible()
  const box = (await dialog.boundingBox())!
  expect(box.width).toBeGreaterThan(390 - 40)
  await page.getByTestId('palette-input').fill('#pick')
  await expect(items(page).first()).toContainText('Pick a database')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
})

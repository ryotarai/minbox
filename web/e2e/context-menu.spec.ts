import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Right-click menus (components/ContextMenu.tsx): at the pointer, Shift+F10 from the keyboard,
// a long press on touch; Esc / an outside click close them; one is open at a time.

async function askThread(page: Page, dir: string) {
  await createSession(page, dir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
}

const row = (page: Page) => page.getByTestId('thread-row').filter({ hasText: 'Pick a database' })

test('thread row: right-click opens the menu at the pointer; Esc and an outside click close it; Pin works', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await askThread(page, minbox.dataDir)
  const menu = page.getByTestId('thread-context-menu')
  const box = (await row(page).boundingBox())!
  const x = Math.round(box.x + 60)
  const y = Math.round(box.y + box.height / 2)
  await page.mouse.click(x, y, { button: 'right' })
  await expect(menu).toBeVisible()
  await expect(row(page)).toHaveAttribute('aria-haspopup', 'menu')
  const m = (await menu.boundingBox())!
  expect(Math.abs(m.x - x)).toBeLessThanOrEqual(2)
  expect(Math.abs(m.y - y)).toBeLessThanOrEqual(2)
  // The items are the thread's own actions, Open first; focus is on the first.
  await expect(menu.getByRole('menuitem').first()).toHaveText('Open')
  await expect(page.getByTestId('thread-open')).toBeFocused()
  await expect(menu.getByTestId('thread-pin')).toHaveText('Pin thread')
  await expect(menu.getByTestId('thread-archive')).toBeVisible()
  // The right-click did not open the thread.
  await expect(page.getByTestId('thread-view')).toHaveCount(0)

  // Esc closes and gives focus back to the row.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(row(page)).toBeFocused()

  // An outside click closes it.
  await page.mouse.click(x, y, { button: 'right' })
  await expect(menu).toBeVisible()
  const pane = (await page.getByTestId('thread-pane').boundingBox())!
  await page.mouse.click(pane.x + pane.width / 2, pane.y + pane.height / 2)
  await expect(menu).toHaveCount(0)

  // An action: Pin, then the next menu offers Unpin.
  await page.mouse.click(x, y, { button: 'right' })
  await menu.getByTestId('thread-pin').click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('thread-view')).toHaveCount(0)
  await expect
    .poll(async () => {
      await page.mouse.click(x, y, { button: 'right' })
      const t = await menu.getByTestId('thread-pin').textContent()
      await page.keyboard.press('Escape')
      return t
    })
    .toBe('Unpin thread')
})

test('thread row: Shift+F10 opens the menu under the row; arrows move; Enter on Open opens the thread', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await askThread(page, minbox.dataDir)
  const menu = page.getByTestId('thread-context-menu')
  await row(page).focus()
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  const r = (await row(page).boundingBox())!
  const m = (await menu.boundingBox())!
  expect(Math.abs(m.y - (r.y + r.height + 4))).toBeLessThanOrEqual(2)
  expect(Math.abs(m.x - r.x)).toBeLessThanOrEqual(2)
  await expect(page.getByTestId('thread-open')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('thread-open-tab')).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByTestId('thread-archive')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('thread-open')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByTestId('thread-archive')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(page.getByTestId('thread-open')).toBeFocused()
  // A single-key shortcut of the page underneath does nothing while the menu has focus.
  await page.keyboard.press('e')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(row(page)).toBeFocused()

  // The context-menu key does the same; Enter activates.
  await page.keyboard.press('ContextMenu')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
})

test('thread row: Archive from the menu (with Undo), and a message menu replaces the row menu', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await askThread(page, minbox.dataDir)
  await row(page).click()
  await expect(page.getByTestId('thread-view')).toContainText('Which database')

  // Messages: right-click on the text (no selection) → Reply, Copy text, Start new thread from here.
  const rowMenu = page.getByTestId('thread-context-menu')
  const msgMenu = page.getByTestId('message-context-menu')
  await row(page).click({ button: 'right' })
  await expect(rowMenu).toBeVisible()
  const msg = page.locator('[data-testid="message"][data-author="claude"]').first()
  await msg.getByText('I need a decision.').click({ button: 'right' })
  await expect(msgMenu).toBeVisible()
  await expect(rowMenu).toHaveCount(0)
  await msgMenu.getByTestId('message-copy').click()
  await expect(msgMenu).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('I need a decision.')
  // Reply focuses the reply box.
  await msg.getByText('I need a decision.').click({ button: 'right' })
  await msgMenu.getByTestId('message-reply').click()
  await expect(page.getByTestId('reply-box')).toBeFocused()
  // Selected text keeps the browser's own menu (no menu of ours).
  await msg.getByText('I need a decision.').selectText()
  await msg.getByText('I need a decision.').click({ button: 'right' })
  await expect(msgMenu).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Archive from the row menu: the same Undo toast as the thread's own menu; the open thread closes.
  await row(page).click({ button: 'right' })
  await rowMenu.getByTestId('thread-archive').click()
  await expect(page.getByText('Archived · "Pick a database"')).toBeVisible()
  await expect(page.getByTestId('thread-view')).toHaveCount(0)
  await expect(row(page)).toHaveCount(0)
  await page.getByTestId('undo').click()
  await expect(row(page)).toHaveCount(1)
})

test('project rail: right-click on a project opens its menu at the pointer', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await askThread(page, minbox.dataDir)
  const item = page.getByTestId('project-item').first()
  const b = (await item.boundingBox())!
  await page.mouse.click(b.x + 30, b.y + 15, { button: 'right' })
  const menu = page.getByTestId('project-context-menu')
  await expect(menu).toBeVisible()
  const m = (await menu.boundingBox())!
  expect(Math.abs(m.x - (b.x + 30))).toBeLessThanOrEqual(2)
  await expect(menu.getByTestId('project-rename')).toBeFocused()
  await expect(menu.getByTestId('project-pin')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('attachment tile: right-click → Open / Download / Copy path; the message menu does not open with it', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'files')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'attach')
  await expectTerminal(page, /sent attach in thr_/)
  await page.getByTestId('thread-row').filter({ hasText: 'The plan' }).click()
  const card = page.getByTestId('attachment-card').filter({ hasText: 'plan.md' })
  await card.click({ button: 'right' })
  const menu = page.getByTestId('attachment-context-menu')
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('message-context-menu')).toHaveCount(0)
  await expect(menu.getByTestId('attachment-open')).toBeFocused()
  await expect(menu.getByTestId('attachment-download')).toBeVisible()
  await menu.getByTestId('attachment-copy-path').click()
  await expect(menu).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/plan\.md$/)
  await card.click({ button: 'right' })
  await menu.getByTestId('attachment-open').click()
  await expect(page.getByTestId('attachment-viewer')).toBeVisible()
})

test('Settings › Hosts: right-click on a host row opens the host menu', async ({ page, minbox }) => {
  await page.goto(minbox.url + '/#v=settings&ss=hosts')
  const hostRow = page.getByTestId('host-row').first()
  await expect(hostRow).toContainText('This machine')
  await hostRow.click({ button: 'right', position: { x: 200, y: 20 } })
  const menu = page.getByTestId('host-context-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('host-rename')).toBeFocused()
  // The built-in host has no URL to edit or pairing to redo, as in its "…" menu.
  await expect(menu.getByTestId('host-remove')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a long press on a thread row opens the menu without opening the thread; moving cancels it', async ({ page, minbox }) => {
    test.setTimeout(120_000)
    await page.goto(minbox.url)
    await askThread(page, minbox.dataDir)
    await page.getByTestId('mobile-back').click()
    await expect(row(page)).toBeVisible()
    const cdp = await page.context().newCDPSession(page)
    const b = (await row(page).boundingBox())!
    const x = Math.round(b.x + b.width / 2)
    const y = Math.round(b.y + b.height / 2)
    const menu = page.getByTestId('thread-context-menu')

    // A press that moves (a scroll) opens nothing.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 6 * i }] })
    await page.waitForTimeout(800)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(200)
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')

    // A long press: the menu, at the finger; the thread does not open.
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.waitForTimeout(800)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect(menu).toBeVisible()
    await page.waitForTimeout(300)
    await expect(menu).toBeVisible()
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
    const m = (await menu.boundingBox())!
    expect(m.x).toBeGreaterThanOrEqual(0)
    expect(m.x + m.width).toBeLessThanOrEqual(390)
    expect(m.y + m.height).toBeLessThanOrEqual(844)

    // An item works by tap.
    const pin = (await menu.getByTestId('thread-pin').boundingBox())!
    await page.touchscreen.tap(pin.x + pin.width / 2, pin.y + pin.height / 2)
    await expect(menu).toHaveCount(0)
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')

    // A plain tap still opens the thread.
    await page.touchscreen.tap(x, y)
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  })
})

import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// New › Shell opens the host's own login shell: a terminal with no inbox.
// Claude Code sessions carry the title Claude sets with set_session_title.

test('New › Shell opens a plain login shell with no inbox', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'plain', 'shell')
  const row = page.getByTestId('session-row').filter({ hasText: 'plain' })
  await expect(row.getByTestId('session-status')).toHaveText('Shell')
  await expect(page.getByTestId('inbox-pane')).toHaveCount(0)
  await typeInTerminal(page, 'echo "kind=$MINBOX_SESSION_ID/$((6*7))"')
  await expectTerminal(page, 'kind=/42') // a real shell, without minbox's mod variables

  // The choice is remembered for the next New.
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('new-session-kind-shell')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('new-session-start')).toContainText('Start shell')
})

test("Claude's session title shows in the session list", async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'work')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'title Fix   the login redirect loop')
  const row = page.getByTestId('session-row').filter({ hasText: 'work' })
  await expect(row.getByTestId('session-title')).toHaveText('Fix the login redirect loop')
  await typeInTerminal(page, 'title Add search')
  await expect(row.getByTestId('session-title')).toHaveText('Add search')
})

test('phone: with the keyboard up, the terminal takes the screen and shows the cursor', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pocket-shell', 'shell')
  // Fill the screen so the cursor sits on the last rows.
  await typeInTerminal(page, 'clear; for i in $(seq 1 80); do echo line$i; done')
  await expectTerminal(page, 'line80')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('session-row').filter({ hasText: 'pocket-shell' }).click()
  await expect(page.getByTestId('term-key-esc')).toBeVisible()
  await expect(page.getByTestId('mobile-back')).toBeVisible()

  // The on-screen keyboard: the visual viewport loses about half its height.
  await page.setViewportSize({ width: 390, height: 420 })
  await expect(page.getByTestId('phone')).toHaveAttribute('data-keyboard', 'true')
  await expect(page.getByTestId('mobile-back')).toBeHidden()
  await expect(page.getByTestId('term-key-esc')).toBeVisible()
  const cursorShown = () =>
    page.evaluate(() => {
      const t = (window as unknown as { __minboxTerminal: { rows: number; buffer: { active: { cursorY: number } } } }).__minboxTerminal
      const canvas = document.querySelector('[data-testid="terminal"] canvas') as HTMLCanvasElement
      const box = canvas.closest('[data-testid="terminal"]')!.parentElement!
      const ch = canvas.getBoundingClientRect().height / t.rows
      const y = canvas.getBoundingClientRect().top + t.buffer.active.cursorY * ch
      const b = box.getBoundingClientRect()
      return y >= b.top && y + ch <= b.bottom
    })
  await expect.poll(cursorShown).toBe(true)

  // Keyboard down: the header and tabs come back.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('mobile-back')).toBeVisible()
})

test('the PTY takes the smallest open screen, and grows back when it closes', async ({ page, browser, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'shared', 'shell')
  const size = page.getByTestId('pty-size')
  await expect(size).toHaveText(/\d+×\d+/)
  const desktop = (await size.textContent())!
  const [dc, dr] = desktop.split('×').map(Number)

  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const phone = await phoneCtx.newPage()
  await phone.goto(minbox.url)
  await phone.getByTestId('session-row').filter({ hasText: 'shared' }).click()
  const phoneSize = () => phone.evaluate(() => {
    const t = (window as unknown as { __minboxTerminal?: { cols: number; rows: number } }).__minboxTerminal
    return t ? `${t.cols}×${t.rows}` : ''
  })
  await expect.poll(phoneSize).toMatch(/\d+×\d+/)
  // Both show the phone's width; the desktop draws the smaller terminal.
  await expect.poll(async () => Number((await size.textContent())!.split('×')[0])).toBeLessThan(dc! / 2)
  await expect.poll(phoneSize).toBe((await size.textContent())!)
  await typeInTerminal(page, 'echo cols=$(tput cols)')
  await expectTerminal(page, new RegExp(`cols=${(await size.textContent())!.split('×')[0]}`))

  // The phone leaves: back to the desktop's size.
  await phoneCtx.close()
  await expect(size).toHaveText(`${dc}×${dr}`)
})

/** A one-finger swipe over the terminal, as touch events. */
async function swipe(page: import('@playwright/test').Page, dy: number) {
  await page.evaluate((dy) => {
    const el = document.querySelector('[data-testid="terminal"]') as HTMLElement
    const r = el.getBoundingClientRect()
    const x = r.left + r.width / 2
    const y0 = r.top + r.height / 2 - dy / 2
    const t = (y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y })
    const fire = (type: string, y: number, list = true) =>
      el.dispatchEvent(new TouchEvent(type, { touches: list ? [t(y)] : [], changedTouches: [t(y)], bubbles: true, cancelable: true }))
    fire('touchstart', y0)
    for (let i = 1; i <= 10; i++) fire('touchmove', y0 + (dy * i) / 10)
    fire('touchend', y0 + dy, false)
  }, dy)
}

test('phone: a swipe scrolls the terminal, or reaches a program that tracks the mouse', async ({ page: desk, browser, minbox }) => {
  await desk.goto(minbox.url)
  await createSession(desk, minbox.dataDir, 'swipe')
  await expectTerminal(desk, 'ready>')
  await desk.close()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await page.goto(minbox.url)
  await page.getByTestId('session-row').filter({ hasText: 'swipe' }).click()
  await page.getByTestId('mobile-tab-terminal').click()
  await expectTerminal(page, 'ready>')

  // A full-screen program that tracks the mouse gets wheel events.
  await typeInTerminal(page, 'mouse')
  await page.waitForTimeout(500)
  await swipe(page, 200) // finger down: back
  await swipe(page, -200) // finger up: forward
  await page.waitForTimeout(1500) // the glide ends
  await page.getByTestId('terminal').click()
  await page.keyboard.press('q')
  const joined = async () => (await terminalText(page)).replace(/\n/g, '')
  await expect.poll(joined, { timeout: 15_000 }).toMatch(/mouse got: b'.*\\x1b\[<64;\d+;\d+M.*\\x1b\[<65;\d+;\d+M/)
  await ctx.close()
})

test('phone: a swipe scrolls a shell through its scrollback', async ({ page: desk, browser, minbox }) => {
  await desk.goto(minbox.url)
  await createSession(desk, minbox.dataDir, 'scrollback', 'shell')
  await typeInTerminal(desk, 'for i in $(seq 1 300); do echo row$i; done')
  await expectTerminal(desk, 'row300')
  await desk.close()
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const page = await ctx.newPage()
  await page.goto(minbox.url)
  await page.getByTestId('session-row').filter({ hasText: 'scrollback' }).click()
  await expectTerminal(page, 'row300')
  const viewportY = () =>
    page.evaluate(() => (window as unknown as { __minboxTerminal: { getViewportY(): number } }).__minboxTerminal.getViewportY()) // lines back from the bottom
  expect(await viewportY()).toBe(0)
  await swipe(page, 300) // finger down: back through the scrollback
  await expect.poll(viewportY).toBeGreaterThan(5)
  const back = await viewportY()
  await page.waitForTimeout(1500)
  await swipe(page, -600) // and forward again
  await expect.poll(viewportY).toBeLessThan(back)
  await ctx.close()
})

import { createSession, expect, expectTerminal, phoneSelectSession, sessionStatus, terminalText, test, typeInTerminal } from './fixtures'

// New › Shell opens the host's own login shell: a terminal with no inbox.
// Claude Code sessions carry the title Claude sets with set_session_title.

test('New › Shell opens a plain login shell with no inbox', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'plain', 'shell')
  await expect(sessionStatus(page)).toHaveText('Shell')
  await expect(page.getByTestId('thread-pane')).toBeVisible()
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
  await expect(page.getByTestId('terminal-session-title')).toHaveText('Fix the login redirect loop')
  await typeInTerminal(page, 'title Add search')
  await expect(page.getByTestId('terminal-session-title')).toHaveText('Add search')
})

test('phone: with the keyboard up, the terminal takes the screen and shows the cursor', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pocket-shell', 'shell')
  // Fill the screen so the cursor sits on the last rows.
  await typeInTerminal(page, 'clear; for i in $(seq 1 80); do echo line$i; done')
  await expectTerminal(page, 'line80')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await phoneSelectSession(page, 'pocket-shell', 'terminal')
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
  await phoneSelectSession(phone, 'shared', 'terminal')
  const phoneSize = () => phone.evaluate(() => {
    const t = (window as unknown as { __minboxTerminal?: { cols: number; rows: number } }).__minboxTerminal
    return t ? `${t.cols}×${t.rows}` : ''
  })
  await expect.poll(phoneSize).toMatch(/\d+×\d+/)
  // Both show the phone's width; the desktop draws the smaller terminal.
  await expect.poll(async () => Number((await size.textContent())!.split('×')[0])).toBeLessThan(dc! * 0.8)
  await expect.poll(phoneSize).toBe((await size.textContent())!)
  await typeInTerminal(page, 'echo cols=$(tput cols)')
  await expectTerminal(page, new RegExp(`cols=${(await size.textContent())!.split('×')[0]}`))

  // The phone leaves: back to the desktop's size.
  await phoneCtx.close()
  await expect(size).toHaveText(`${dc}×${dr}`)
})

test('a phone limits the PTY only while its terminal is shown', async ({ page, browser, minbox }) => {
  test.setTimeout(120_000)
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'shared', 'shell')
  const size = page.getByTestId('pty-size')
  await expect(size).toHaveText(/\d+×\d+/)
  const desktop = (await size.textContent())!
  const [dc] = desktop.split('×').map(Number)

  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const phone = await phoneCtx.newPage()
  await phone.goto(minbox.url)
  await phoneSelectSession(phone, 'shared', 'terminal')
  await expect.poll(async () => Number((await size.textContent())!.split('×')[0])).toBeLessThan(dc! * 0.8)

  // Back to the inbox on the phone: the desktop's size returns.
  await phone.getByTestId('mobile-back').click()
  await expect(size).toHaveText(desktop)

  // Open it again, then hide the page (phone locked): it stops repeating its size (a lease the
  // host lets lapse after 15 s, the socket staying open), so the size returns.
  await phoneSelectSession(phone, 'shared', 'terminal')
  await expect.poll(async () => Number((await size.textContent())!.split('×')[0])).toBeLessThan(dc! * 0.8)
  const setVisibility = (state: 'hidden' | 'visible') =>
    phone.evaluate((state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
      document.dispatchEvent(new Event('visibilitychange'))
    }, state)
  await setVisibility('hidden')
  await expect(size).toHaveText(desktop, { timeout: 30_000 })
  // Shown again: it tells its size at once and limits the PTY once more.
  await setVisibility('visible')
  await expect.poll(async () => Number((await size.textContent())!.split('×')[0])).toBeLessThan(dc! * 0.8)
  await phoneCtx.close()
  await expect(size).toHaveText(desktop)
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
  await phoneSelectSession(page, 'swipe', 'terminal')
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
  await phoneSelectSession(page, 'scrollback', 'terminal')
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

test('on a Mac only ⌘K opens quick actions; Ctrl+K stays the terminal’s', async ({ page, minbox }) => {
  test.skip(process.platform !== 'darwin', 'the Mac binding')
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'keys', 'shell')
  await typeInTerminal(page, 'echo first')
  await expectTerminal(page, /^first$/m)
  // Ctrl+K in the shell kills the rest of the line, and no palette opens.
  await page.keyboard.type('echo kept; echo gone')
  for (let i = 0; i < 'echo gone'.length; i++) await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Control+k')
  await page.keyboard.press('Enter')
  await expectTerminal(page, /^kept$/m)
  await expect(page.getByTestId('palette-input')).toHaveCount(0)
  expect(await terminalText(page)).not.toMatch(/^gone$/m)
  await page.keyboard.press('Meta+k')
  await expect(page.getByTestId('palette-input')).toBeVisible()
})

test("Claude's open_url opens the page in the person's browser, or offers it when blocked", async ({ page, browser, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'opener')
  await expectTerminal(page, 'ready>')
  // A second browser whose popups are blocked gets the page in a toast.
  const other = await browser.newContext()
  const blocked = await other.newPage()
  await blocked.addInitScript(() => {
    const real = window.open.bind(window)
    ;(window as any).__realOpen = real
    window.open = () => null
  })
  await blocked.goto(minbox.url)
  await expect(blocked.getByTestId('threads-pane')).toBeVisible()

  const target = `${minbox.url}/?opened-by-claude`
  const popup = page.waitForEvent('popup')
  await typeInTerminal(page, `openurl ${target}`)
  await expectTerminal(page, `opened ${target}`)
  expect((await popup).url()).toContain(target) // the app adds its own #route

  const notice = blocked.getByTestId('notice').filter({ hasText: 'opener: Claude wants to open' })
  await expect(notice).toContainText(target)
  await expect(notice.getByTestId('undo')).toHaveText('Open')
  await other.close()

  // Not a web page: refused.
  await typeInTerminal(page, 'openurl file:///etc/passwd')
  await expectTerminal(page, 'url must be an absolute http(s) URL')
})

test('desktop with a mouse: no on-screen terminal keys', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'mouse-shell', 'shell')
  await typeInTerminal(page, 'echo ready-$((1+1))')
  await expectTerminal(page, 'ready-2')
  await expect(page.getByTestId('desktop')).toBeVisible()
  await expect(page.getByTestId('term-key-esc')).toHaveCount(0)
})

test.describe('tablet / unfolded foldable (touch, wide screen)', () => {
  test.use({ hasTouch: true, viewport: { width: 1200, height: 800 } })

  test('the wide layout shows the terminal keys and they reach the shell', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'fold-shell', 'shell')
    await expect(page.getByTestId('desktop')).toBeVisible()
    await expect(page.getByTestId('term-key-esc')).toBeVisible()
    await expect(page.getByTestId('term-key-tab')).toBeVisible()
    await expect(page.getByTestId('term-key-ctrl')).toBeVisible()

    // ← moves the cursor back one: "echo k-ab", ←, "X" runs `echo k-aXb`.
    await page.getByTestId('terminal').click()
    await page.keyboard.type('echo k-ab')
    await page.getByTestId('term-key-left').click()
    await page.keyboard.type('X')
    await page.keyboard.press('Enter')
    await expectTerminal(page, 'k-aXb')

    // Ctrl armed, then "c": an interrupt.
    await page.getByTestId('terminal').click()
    await page.keyboard.type('sleep 30')
    await page.keyboard.press('Enter')
    await page.getByTestId('term-key-ctrl').click()
    await expect(page.getByTestId('term-key-ctrl')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('terminal').click()
    await page.keyboard.type('c')
    await typeInTerminal(page, 'echo after-$((6*7))')
    await expectTerminal(page, 'after-42')
  })

  test('a finger drag on the thread/terminal edge resizes the thread pane', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'fold-claude')
    const inbox = page.getByTestId('thread-pane')
    await expect(inbox).toBeVisible()
    const before = (await inbox.boundingBox())!.width
    const edge = (await page.getByTestId('resizer').nth(1).boundingBox())!
    const x = edge.x + edge.width / 2, y = edge.y + edge.height / 2
    // A real touch sequence (not mouse events): without touch-action: none the browser takes it as a pan.
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 6 * i, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    // The edge follows the finger 1:1 (it dragged 60px left: the thread pane is that much narrower).
    await expect.poll(async () => Math.round(before - (await inbox.boundingBox())!.width)).toBeGreaterThanOrEqual(58)
    expect(before - (await inbox.boundingBox())!.width).toBeLessThanOrEqual(62)
  })
})

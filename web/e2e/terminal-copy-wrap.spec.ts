import type { Page } from '@playwright/test'
import { createSession, createShellSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// A line longer than the terminal is wide is soft-wrapped over several rows. Copying it must
// give the line back whole: no line break where the terminal wrapped it (ghostty-web's own
// selection text ended every row with one).

const LINE = Array.from({ length: 90 }, (_, i) => String(i + 1)).join(' ') // 260 chars, spaces at some wrap points
const PRINT = 'echo $(seq 1 90); echo done-$((6*7))'

type Which = 'session' | 'shell'
const termKey = (which: Which) => (which === 'shell' ? '__minboxShellTerminal' : '__minboxTerminal')

async function size(page: Page, which: Which) {
  return page.evaluate((k) => {
    const t = (window as any)[k]
    return { cols: t.cols as number, rows: t.rows as number, viewportY: t.viewportY as number }
  }, termKey(which))
}

/** The viewport row the line starts on, and how many rows it takes. */
async function lineRows(page: Page, which: Which) {
  const { cols, rows } = await size(page, which)
  const screen = (await terminalText(page, which)).split('\n').slice(-rows)
  const first = screen.findIndex((l) => l.startsWith('1 2 3 4 5'))
  expect(first).toBeGreaterThanOrEqual(0)
  return { first, count: Math.ceil(LINE.length / cols), cols, rows }
}

/** Drags from the line's first cell to its last, as a person selects it; returns the clipboard. */
async function dragCopy(page: Page, which: Which, canvasSel: string) {
  const { first, count, cols, rows } = await lineRows(page, which)
  expect(count).toBeGreaterThan(1) // it does wrap
  const box = (await page.locator(canvasSel).boundingBox())!
  const cw = box.width / cols
  const ch = box.height / rows
  const lastCol = (LINE.length - 1) % cols
  await page.evaluate(() => navigator.clipboard.writeText('-'))
  await page.mouse.move(box.x + cw * 0.3, box.y + ch * (first + 0.5))
  await page.mouse.down()
  await page.mouse.move(box.x + cw * (lastCol + 0.7), box.y + ch * (first + count - 1 + 0.5), { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe('-')
  return page.evaluate(() => navigator.clipboard.readText())
}

/** The PTY's width as the program in it sees it: the same as the drawn terminal's. */
async function expectPtyCols(page: Page, which: Which, type: (s: string) => Promise<void>) {
  const tag = `pty-${Math.random().toString(36).slice(2, 7)}`
  await type(`echo ${tag}=$(tput cols)`)
  await expect.poll(async () => (await terminalText(page, which)).match(new RegExp(`^${tag}=(\\d+)$`, 'm'))?.[1], { timeout: 15_000 }).toBe(
    String((await size(page, which)).cols),
  )
}

test('the agent terminal copies a soft-wrapped line without line breaks, on screen and from the scrollback', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createShellSession(page, minbox, 'wrapcopy')
  await expectPtyCols(page, 'session', (s) => typeInTerminal(page, s))
  await typeInTerminal(page, PRINT)
  await expectTerminal(page, 'done-42')

  expect(await dragCopy(page, 'session', '.mb-term canvas')).toBe(LINE)
  expect(await page.evaluate(() => (window as any).__minboxTerminal.getSelection())).toBe(LINE)

  // Push it into the scrollback, then select it there along with the rows around it: the line
  // stays whole, and the real line breaks around it stay.
  await typeInTerminal(page, 'seq 1 80; echo end-$((6*7))')
  await expectTerminal(page, 'end-42')
  const text = await page.evaluate(() => {
    const t = (window as any).__minboxTerminal
    const w = t.wasmTerm
    const sb = w.getScrollbackLength() as number
    const row = (i: number) => (w.getScrollbackLine(i) as { codepoint: number }[]).map((c) => (c.codepoint ? String.fromCodePoint(c.codepoint) : ' ')).join('')
    let start = -1
    for (let i = 0; i < sb; i++) if (row(i).startsWith('1 2 3 4 5')) start = i
    if (start < 1) return `not in the scrollback (${sb})`
    const sm = t.selectionManager
    sm.selectionStart = { col: 0, absoluteRow: start - 1 }
    sm.selectionEnd = { col: t.cols - 1, absoluteRow: start + Math.ceil(260 / t.cols) }
    return t.getSelection() as string
  })
  const lines = text.split('\n')
  expect(lines).toHaveLength(3)
  expect(lines[0]).toContain(PRINT)
  expect(lines[1]).toBe(LINE)
  expect(lines[2]).toBe('done-42')

  // Wide characters: one that no longer fits in the last column wraps whole, leaving that column
  // empty; neither that column nor a wide character's second half adds a space.
  const [got, want] = await page.evaluate(
    () =>
      new Promise<[string, string]>((resolve) => {
        const t = (window as any).__minboxTerminal
        const line = 'x'.repeat(t.cols - 1) + '日本語 ok'
        t.write('\r\n' + line + '\r\n', () => {
          const sb = t.wasmTerm.getScrollbackLength()
          const y = t.wasmTerm.getCursor().y as number
          const sm = t.selectionManager
          sm.selectionStart = { col: 0, absoluteRow: sb + y - 2 }
          sm.selectionEnd = { col: t.cols - 1, absoluteRow: sb + y - 1 }
          resolve([t.getSelection(), line])
        })
      }),
  )
  expect(got).toBe(want)
})

test('the shell pane copies a soft-wrapped line without line breaks', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'shellwrap')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('shell-toggle').click()
  const pane = page.getByTestId('shell-pane').getByTestId('terminal')
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).toContain('❯')
  const type = async (s: string) => {
    await pane.click()
    await page.keyboard.type(s)
    await page.keyboard.press('Enter')
  }
  await expectPtyCols(page, 'shell', type)
  await type(PRINT)
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).toMatch(/^done-42$/m)
  expect(await dragCopy(page, 'shell', '[data-testid="shell-pane"] canvas')).toBe(LINE)

  // A narrower window: the PTY follows the new width, and a line printed at it copies whole.
  await page.setViewportSize({ width: 1100, height: 900 })
  await expectPtyCols(page, 'shell', type)
  await type('clear')
  await type(PRINT)
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).toMatch(/^done-42$/m)
  expect(await dragCopy(page, 'shell', '[data-testid="shell-pane"] canvas')).toBe(LINE)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the terminal on a phone keeps the PTY at its width and copies a wrapped line whole', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createShellSession(page, minbox, 'phonewrap')
    await expectPtyCols(page, 'session', (s) => typeInTerminal(page, s))
    await typeInTerminal(page, PRINT)
    await expectTerminal(page, 'done-42')
    const { first, count, cols } = await lineRows(page, 'session')
    expect(count).toBeGreaterThan(2)
    const sel = await page.evaluate(
      ({ first, count, cols }) => {
        const t = (window as any).__minboxTerminal
        const top = t.wasmTerm.getScrollbackLength() - t.viewportY
        t.selectionManager.selectionStart = { col: 0, absoluteRow: top + first }
        t.selectionManager.selectionEnd = { col: cols - 1, absoluteRow: top + first + count - 1 }
        return t.getSelection() as string
      },
      { first, count, cols },
    )
    expect(sel).toBe(LINE)
  })
})

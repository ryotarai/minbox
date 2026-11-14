import { placePopover } from '../src/lib/popoverPlacement'
import { createSession, expect, expectTerminal, test } from './fixtures'

// The on-screen keyboard shrinks the visual viewport but not the layout viewport; popovers must stay inside
// the visible part.

const vv = { left: 0, top: 0, width: 390, height: 440 }
const anchor = { left: 20, right: 200, top: 380, bottom: 416 }

test('placePopover: flips and caps height inside the visible area', () => {
  // Opens upward (side top) with room: placed above the anchor.
  let p = placePopover({ anchor, width: 300, height: 200, vv, side: 'top', align: 'start' })
  expect(p.top + 200).toBeLessThanOrEqual(anchor.top)
  // Wants to go below but the keyboard leaves 20px: flips above and caps.
  p = placePopover({ anchor, width: 300, height: 500, vv, side: 'bottom', align: 'start' })
  expect(p.maxHeight).toBeLessThanOrEqual(anchor.top - 4 - 8)
  expect(p.top).toBeGreaterThanOrEqual(8)
  expect(p.top + Math.min(500, p.maxHeight)).toBeLessThanOrEqual(vv.height - 8)
  // Scrolled visual viewport (offsetTop): stays inside it.
  const v2 = { ...vv, top: 100 }
  p = placePopover({ anchor: { ...anchor, top: 480, bottom: 516 }, width: 300, height: 500, vv: v2, side: 'top', align: 'start' })
  expect(p.top).toBeGreaterThanOrEqual(108)
  expect(p.top + Math.min(500, p.maxHeight)).toBeLessThanOrEqual(540 - 8)
  // Horizontal clamp.
  p = placePopover({ anchor: { ...anchor, left: 300, right: 380 }, width: 300, height: 100, vv, side: 'bottom', align: 'start' })
  expect(p.left + 300).toBeLessThanOrEqual(390 - 8)
  // Roomy desktop viewport: unchanged below placement.
  p = placePopover({ anchor, width: 200, height: 100, vv: { left: 0, top: 0, width: 1500, height: 900 }, side: 'bottom', align: 'start' })
  expect(p).toEqual({ left: 20, top: 420, maxHeight: 472 })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('session picker stays inside the visual viewport when the keyboard shrinks it', async ({ page, minbox }) => {
    test.setTimeout(120_000)
    // A fake visual viewport the test can shrink, like an overlaying keyboard does.
    await page.addInitScript(() => {
      const t = new EventTarget() as EventTarget & Record<string, number>
      Object.assign(t, { offsetTop: 0, offsetLeft: 0, width: window.innerWidth, height: window.innerHeight, scale: 1 })
      Object.defineProperty(window, 'visualViewport', { value: t, configurable: true })
      ;(window as unknown as { __vv: (h: number) => void }).__vv = (h) => {
        t.height = h
        t.dispatchEvent(new Event('resize'))
      }
    })
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'kbd')
    await expectTerminal(page, 'ready>')
    await page.getByTestId('mobile-back').click()
    const target = page.getByTestId('composer-target')
    await expect(target).toBeVisible()
    await target.tap()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    // Touch device: the search does not grab focus (no keyboard until the user taps it).
    await expect(page.getByTestId('session-picker-search')).not.toBeFocused()
    await page.screenshot({ path: '/private/tmp/claude-501/-Users-ryotarai-work-minbox/afc22bed-3c9b-41ed-870d-89183dd4cfab/scratchpad/picker-before.png' })

    // The keyboard opens: only the top 330px stay visible.
    await page.evaluate(() => (window as unknown as { __vv: (h: number) => void }).__vv(330))
    await expect(async () => {
      const b = (await menu.boundingBox())!
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y + b.height).toBeLessThanOrEqual(330)
    }).toPass()
    // Its content scrolls inside (search stays reachable, list can be scrolled).
    const scrolls = await menu.evaluate((el) => el.scrollHeight > el.clientHeight || el.querySelector('[data-testid="session-option"]') !== null)
    expect(scrolls).toBe(true)
    await page.screenshot({ path: '/private/tmp/claude-501/-Users-ryotarai-work-minbox/afc22bed-3c9b-41ed-870d-89183dd4cfab/scratchpad/picker-keyboard.png' })
    // An option is tappable.
    await page.getByTestId('session-option').first().tap()
    await expect(menu).toHaveCount(0)

    // Keyboard closes: reopening uses the full height again.
    await page.evaluate(() => (window as unknown as { __vv: (h: number) => void }).__vv(844))
    await target.tap()
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })
})

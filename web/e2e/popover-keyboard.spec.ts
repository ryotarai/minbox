import { placePopover } from '../src/lib/popoverPlacement'
import { expect, test } from './fixtures'
import { startAgent } from './v3'

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

  test('a menu stays inside the visual viewport when the keyboard shrinks it; a re-press closes it', async ({ page, minbox }) => {
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
    const a = await startAgent(minbox, 'kbd')
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    // The agent menu in the stream header (a Popover, as main's session picker was).
    const target = page.getByTestId('agent-menu')
    await expect(target).toBeVisible()
    await target.tap()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    // The keyboard opens: only the top 200px stay visible.
    await page.evaluate(() => (window as unknown as { __vv: (h: number) => void }).__vv(200))
    await expect(async () => {
      const b = (await menu.boundingBox())!
      expect(b.y).toBeGreaterThanOrEqual(0)
      expect(b.y + b.height).toBeLessThanOrEqual(200)
    }).toPass()
    // Its content scrolls inside.
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
    // An item is tappable.
    await page.getByTestId('menu-rename').tap()
    await expect(menu).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Keyboard closes: reopening uses the full height again; pressing the button again closes it.
    await page.evaluate(() => (window as unknown as { __vv: (h: number) => void }).__vv(844))
    await target.tap()
    await expect(menu).toBeVisible()
    expect(await menu.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
    await target.tap()
    await expect(menu).toHaveCount(0)
  })
})

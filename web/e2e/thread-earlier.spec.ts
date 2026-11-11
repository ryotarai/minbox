import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// "N earlier messages" expands the folded history ABOVE what the person is reading. The view must keep
// the message that was on screen where it was, not jump to the top of the thread.

const para = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')

async function check(page: import('@playwright/test').Page, minbox: { url: string; dataDir: string }, open: () => Promise<void>) {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'earlier')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, `burst 60 ${para}`)
  await expectTerminal(page, 'sent in thr_')
  await open()
  // Opening marked it read; reload so nothing counts as new and the history folds.
  await expect(page.getByTestId('thread-view')).toBeVisible()
  await expect.poll(async () => (await (await page.request.get(minbox.url + '/api/threads')).json()).every((t: { unread: number }) => t.unread === 0)).toBe(true)
  await page.reload()
  const view = page.getByTestId('thread-view')
  const scroller = view.locator('div.overflow-y-auto').first()
  const earlier = view.getByTestId('earlier')
  await expect(earlier).toBeVisible()
  // A mid position near the top of the thread: the folded row is on screen with messages below it.
  await scroller.evaluate((e) => {
    const b = e.querySelector('[data-testid="earlier"]') as HTMLElement
    e.scrollTop += Math.max(1, b.getBoundingClientRect().top - e.getBoundingClientRect().top - 60)
  })
  // Mark the first message that is fully below the pinned bar.
  await scroller.evaluate((e) => {
    const c = e.getBoundingClientRect()
    const all = Array.from(e.querySelectorAll('[data-testid="message"]:not(button)')) as HTMLElement[]
    const m = all.find((x) => x.getBoundingClientRect().top > c.top + 60) ?? all[0]!
    m.setAttribute('data-probe', '1')
  })
  const mark = scroller.locator('[data-probe="1"]')
  const before = (await mark.boundingBox())!
  const top0 = await scroller.evaluate((e) => e.scrollTop)
  await earlier.click()
  await expect(view.getByTestId('earlier')).toHaveCount(0)
  await page.waitForTimeout(400)
  const after = (await mark.boundingBox())!
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2)
  // The older messages were added above: the view moved down with them instead of jumping to the top.
  expect(await scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(top0 + 200)
}

test('desktop: expanding earlier messages keeps the reading position', async ({ page, minbox }) => {
  await check(page, minbox, () => page.getByTestId('thread-row').first().click())
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('phone: expanding earlier messages keeps the reading position', async ({ page, minbox }) => {
    await check(page, minbox, async () => {
      await page.getByTestId('mobile-back').click()
      await page.getByTestId('thread-row').first().tap()
      await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
    })
  })
})

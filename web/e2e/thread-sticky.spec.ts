import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// The thread's header block (title, status, Linear bar) stays reachable while a long thread scrolls:
// once it is out of view a compact bar is pinned to the top of the scroll area.

const para = Array.from({ length: 110 }, (_, i) => `word${i}`).join(' ')

async function longThread(page: import('@playwright/test').Page, minbox: { url: string; dataDir: string }) {
  // The "+ Linear" button shows only while Linear (the fake) is connected.
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'sticky')
  await expectTerminal(page, 'ready>')
  for (let i = 0; i < 5; i++) await typeInTerminal(page, `say ${para}`)
  await expectTerminal(page, 'sent in thr_')
}

async function checkSticky(page: import('@playwright/test').Page, maxH: number) {
  const view = page.getByTestId('thread-view')
  const scroller = view.locator('div.overflow-y-auto').first()
  await expect.poll(() => scroller.evaluate((e) => e.scrollHeight > e.clientHeight + 300)).toBe(true)
  const bar = view.getByTestId('thread-sticky')
  await scroller.evaluate((e) => (e.scrollTop = 0))
  await expect(bar).not.toHaveAttribute('data-stuck', /.*/)
  await expect(view.getByTestId('linear-link-open')).toBeVisible()

  await scroller.evaluate((e) => (e.scrollTop = 600))
  await expect(bar).toHaveAttribute('data-stuck', 'true')
  const compact = bar.locator('div').first()
  await expect(compact).toBeVisible()
  await expect(view.getByTestId('thread-sticky-subject')).toBeVisible()
  await expect(view.getByTestId('linear-link-open-sticky')).toBeVisible()
  const c = (await scroller.boundingBox())!
  const b = (await compact.boundingBox())!
  expect(Math.abs(b.y - c.y)).toBeLessThanOrEqual(1)
  expect(b.height).toBeLessThanOrEqual(maxH)
  // It does not push the messages: scrolling back up lands at the very top.
  await scroller.evaluate((e) => (e.scrollTop = 0))
  await expect(bar).not.toHaveAttribute('data-stuck', /.*/)
  // Jump to the bottom still works with the bar in place.
  await scroller.evaluate((e) => (e.scrollTop = e.scrollHeight))
  await expect(bar).toHaveAttribute('data-stuck', 'true')
  const b2 = (await compact.boundingBox())!
  expect(Math.abs(b2.y - c.y)).toBeLessThanOrEqual(1)
  // The reply box is still below the scroll area, not covered.
  const reply = (await page.getByTestId('reply-box').boundingBox())!
  expect(reply.y).toBeGreaterThanOrEqual(c.y + c.height - 1)
}

test('desktop: the thread header stays pinned to the top while the messages scroll', async ({ page, minbox }) => {
  await longThread(page, minbox)
  await page.getByTestId('thread-row').first().click()
  await checkSticky(page, 48)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('phone: the thread header stays pinned to the top while the messages scroll', async ({ page, minbox }) => {
    await longThread(page, minbox)
    await page.getByTestId('mobile-back').click()
    await page.getByTestId('thread-row').first().tap()
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
    await checkSticky(page, 844 / 4)
  })
})

import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Reply suggestions: up to three chips above the reply box when the agent spoke last. The server
// runs e2e/fake-suggest.py instead of claude (MINBOX_SUGGEST_COMMAND).

async function seed(page: Page, dir: string) {
  await createSession(page, dir, 'sg')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Finished the migration')
  await expectTerminal(page, /sent .*thr_/)
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('thread-subject')).toBeVisible()
}

test('chips appear when the agent spoke last; a click sends the text to the agent', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  const chips = page.getByTestId('reply-suggestion')
  await expect(chips).toHaveCount(3)
  await expect(chips.nth(0)).toContainText('Sounds good, go ahead')
  await chips.nth(0).click()
  await expectTerminal(page, /Sounds good, go ahead/)
  await expect(page.getByTestId('reply-suggestions')).toHaveCount(0)
})

test('the pencil puts the chip text in the reply box without sending', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('reply-suggestion')).toHaveCount(3)
  await page.getByTestId('reply-suggestion-edit').nth(1).click()
  await expect(page.getByTestId('reply-box')).toHaveValue('Thanks, looks good')
  await expect(page.getByTestId('reply-suggestions')).toHaveCount(0) // typed text hides the chips
  await expect(page.getByTestId('delivery-line')).toHaveCount(0)
})

test('typing hides the chips', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('reply-suggestion')).toHaveCount(3)
  await page.getByTestId('reply-box').fill('x')
  await expect(page.getByTestId('reply-suggestions')).toHaveCount(0)
})

test('the setting turns suggestions off', async ({ page, minbox }) => {
  await fetch(minbox.url + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply_suggestions: false }) })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.waitForTimeout(800)
  await expect(page.getByTestId('reply-suggestions')).toHaveCount(0)
  await expect(page.getByTestId('reply-box')).toBeVisible()
})

test('phone: chips wrap above the reply box', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'sg')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Finished the migration')
  await expectTerminal(page, /sent .*thr_/)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('reply-suggestion')).toHaveCount(3)
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
})

// Not a check: screenshots for docs (SCREENSHOTS=1 SCREENSHOT_DIR=docs/img/v2).
test('suggestion screenshots', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('reply-suggestion')).toHaveCount(3)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/sg-desktop.png` })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('reply-suggestion')).toHaveCount(3)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/sg-phone.png` })
})

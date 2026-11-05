import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Below 1100 px the app is single-column (the phone layout), not a collapsed rail: the thread list
// full width, a thread full width with a back button, the terminal behind the session chip / tab.

async function seed(page: Page, dir: string) {
  await createSession(page, dir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await createSession(page, dir, 'beta')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Beta note')
  await expectTerminal(page, /sent .*thr_/)
  await expect(page.getByTestId('thread-row')).toHaveCount(2)
}

const noOverflow = async (page: Page) => {
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
}

async function walk(page: Page, shots?: (n: string) => Promise<void>) {
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
  await expect(page.getByTestId('session-rail')).toHaveCount(0)
  await expect(page.getByTestId('rail-session')).toHaveCount(0)
  await expect(page.getByTestId('desktop')).toHaveCount(0)
  const w = await page.evaluate(() => window.innerWidth)
  const list = (await page.getByTestId('threads-pane').boundingBox())!
  expect(list.width).toBeGreaterThanOrEqual(w - 2)
  await noOverflow(page)
  await shots?.('n-01-narrow-list')

  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
  expect((await page.getByTestId('thread-view').boundingBox())!.width).toBeGreaterThanOrEqual(w - 2)
  await noOverflow(page)
  await shots?.('n-02-narrow-thread')

  await page.getByTestId('phone-session-chip').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'terminal')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await noOverflow(page)
  await shots?.('n-03-narrow-terminal')
  await page.getByTestId('mobile-tab-inbox').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')

  await page.getByTestId('mobile-back').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
  await expect(page.getByTestId('thread-row')).toHaveCount(2)
}

for (const width of [900, 1090]) {
  test(`desktop ${width}px: single column, no rail`, async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await seed(page, minbox.dataDir)
    await page.setViewportSize({ width, height: 800 })
    await page.goto(minbox.url + '/#')
    await walk(page)
  })
}

test.describe('touch tablet', () => {
  test.use({ hasTouch: true, viewport: { width: 1024, height: 768 } })
  test('1024px touch: single column, no rail', async ({ page, minbox }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
    await page.goto(minbox.url)
    await seed(page, minbox.dataDir)
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.goto(minbox.url + '/#')
    await walk(page)
  })
})

test('1100px keeps three columns and no rail', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('desktop')).toBeVisible()
  await expect(page.getByTestId('session-rail')).toHaveCount(0)
  await expect(page.getByTestId('thread-pane')).toBeVisible()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await noOverflow(page)
})

test('resizing from wide to narrow and back keeps the thread, the session and the draft', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await page.setViewportSize({ width: 900, height: 800 })
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('phone-thread-subject')).toHaveText('Pick a database')
  await page.getByTestId('phone-session-chip').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await page.setViewportSize({ width: 1500, height: 900 })
  await expect(page.getByTestId('desktop')).toBeVisible()
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
})

// Not a check: screenshots for docs/ui-v2-threads.md (SCREENSHOTS=1 SCREENSHOT_DIR=docs/img/v2).
test('narrow screenshots', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  test.setTimeout(180_000)
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  mkdirSync(out, { recursive: true })
  const shot = async (name: string) => {
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/${name}.png` })
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await page.setViewportSize({ width: 1100, height: 800 })
  await shot('n-04-1100')
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(minbox.url + '/#')
  await walk(page, shot)
})

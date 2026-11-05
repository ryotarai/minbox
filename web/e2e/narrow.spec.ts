import { mkdirSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Width bands: below 700 px the app is single-column (the phone layout: the thread list full width,
// a thread full width with a back button, the terminal behind the session chip / tab); 700-1099 px
// is the tablet's two panes ([list | thread], or [thread | terminal]); from 1100 px three columns.

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

for (const width of [390, 650, 699]) {
  test(`${width}px: single column (phone), no rail`, async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await seed(page, minbox.dataDir)
    await page.setViewportSize({ width, height: 800 })
    await page.goto(minbox.url + '/#')
    await walk(page)
  })
}

/** Tablet: [project tiles | list | thread]; the terminal toggle makes it [tiles | thread | terminal]. */
async function tabletWalk(page: Page, shots?: (n: string) => Promise<void>) {
  const w = await page.evaluate(() => window.innerWidth)
  await expect(page.getByTestId('phone')).toHaveCount(0)
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'list')
  const rail = (await page.getByTestId('project-rail').boundingBox())!
  expect(rail.width).toBeLessThanOrEqual(60)
  await expect(page.getByTestId('threads-pane')).toBeVisible()
  await expect(page.getByTestId('thread-pane')).toBeVisible()
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await expect(page.getByTestId('quick-compose')).toBeVisible()
  await noOverflow(page)

  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
  const list = (await page.getByTestId('threads-pane').boundingBox())!
  const thread = (await page.getByTestId('thread-pane').boundingBox())!
  expect(list.width).toBeGreaterThanOrEqual(240 - 1)
  expect(thread.width).toBeGreaterThanOrEqual(320 - 1)
  expect(thread.x).toBeGreaterThanOrEqual(list.x + list.width - 1)
  expect(thread.x + thread.width).toBeGreaterThanOrEqual(w - 2)
  await expect(page.getByTestId('reply-box')).toBeVisible()
  await noOverflow(page)
  await shots?.('tb-01-list-thread')

  await page.getByTestId('tablet-terminal').click()
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'terminal')
  await expect(page.getByTestId('threads-pane')).toHaveCount(0)
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
  const t2 = (await page.getByTestId('thread-pane').boundingBox())!
  const term = (await page.getByTestId('terminal').boundingBox())!
  expect(t2.width).toBeGreaterThanOrEqual(320 - 1)
  expect(term.width).toBeGreaterThanOrEqual(300 - 40)
  expect(term.x).toBeGreaterThanOrEqual(t2.x + t2.width - 1)
  expect(term.x + term.width).toBeLessThanOrEqual(w + 1)
  await noOverflow(page)
  await shots?.('tb-02-thread-terminal')

  await page.getByTestId('tablet-threads').click()
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'list')
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  // The thread's own back button leaves the terminal view too.
  await page.getByTestId('tablet-terminal').click()
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'terminal')
  await page.getByTestId('thread-back').click()
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'list')
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
}

for (const [width, height] of [[700, 800], [800, 900], [1000, 800], [1099, 800]]) {
  test(`desktop ${width}px: tablet two panes`, async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await seed(page, minbox.dataDir)
    await page.setViewportSize({ width, height })
    await page.goto(minbox.url + '/#')
    await tabletWalk(page)
  })
}

test.describe('touch tablet', () => {
  test.use({ hasTouch: true })
  for (const [width, height] of [[834, 1112], [1024, 768]]) {
    test(`${width}x${height} touch: tablet two panes`, async ({ page, minbox }) => {
      await page.setViewportSize({ width: 1200, height: 800 })
      await page.goto(minbox.url)
      await seed(page, minbox.dataDir)
      await page.setViewportSize({ width, height })
      await page.goto(minbox.url + '/#')
      await tabletWalk(page)
    })
  }
})

test('tablet: the list width drags; the shell is a full-screen overlay', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.setViewportSize({ width: 900, height: 800 })
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  const before = (await page.getByTestId('threads-pane').boundingBox())!
  const edge = (await page.getByTestId('resizer').first().boundingBox())!
  await page.mouse.move(edge.x + edge.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 + 80, 400, { steps: 4 })
  await page.mouse.up()
  const after = (await page.getByTestId('threads-pane').boundingBox())!
  expect(after.width).toBeGreaterThan(before.width + 40)
  await expect(page.getByTestId('thread-pane')).toBeVisible()
  await noOverflow(page)

  await page.getByTestId('tablet-terminal').click()
  await page.getByTestId('shell-toggle').click()
  const shell = page.getByTestId('phone-shell')
  await expect(shell).toBeVisible()
  expect((await shell.boundingBox())!.width).toBeLessThanOrEqual(900)
  await noOverflow(page)
  await page.getByTestId('shell-close').click()
  await expect(shell).toHaveCount(0)
})

test('three columns from 1100px, no rail', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('desktop')).toBeVisible()
  await expect(page.getByTestId('tablet')).toHaveCount(0)
  await expect(page.getByTestId('session-rail')).toHaveCount(0)
  await expect(page.getByTestId('thread-pane')).toBeVisible()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await noOverflow(page)
})

test('resizing across the bands keeps the thread, the session and the draft', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await page.getByTestId('reply-box').fill('half a reply')
  // desktop -> tablet
  await page.setViewportSize({ width: 800, height: 800 })
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'list')
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await expect(page.getByTestId('reply-box')).toHaveValue('half a reply')
  // tablet terminal view -> phone: the terminal screen
  await page.getByTestId('tablet-terminal').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await page.setViewportSize({ width: 650, height: 800 })
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'terminal')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  // phone thread screen -> tablet
  await page.getByTestId('mobile-tab-inbox').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('reply-box')).toHaveValue('half a reply')
  await page.setViewportSize({ width: 800, height: 800 })
  await expect(page.getByTestId('tablet')).toHaveAttribute('data-view', 'list')
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await expect(page.getByTestId('reply-box')).toHaveValue('half a reply')
  // tablet -> desktop
  await page.setViewportSize({ width: 1200, height: 800 })
  await expect(page.getByTestId('desktop')).toBeVisible()
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('reply-box')).toHaveValue('half a reply')
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
  await page.setViewportSize({ width: 650, height: 800 })
  await page.goto(minbox.url + '/#')
  await walk(page, shot)
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(minbox.url + '/#')
  await tabletWalk(page, async (n) => shot(n.replace('tb-0', 'tb-1000-0')))
  await page.setViewportSize({ width: 834, height: 1112 })
  await page.goto(minbox.url + '/#')
  await tabletWalk(page, shot)
})

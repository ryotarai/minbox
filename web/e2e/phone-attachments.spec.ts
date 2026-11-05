import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Phone (touch, 390x844): tapping an attachment opens its viewer full screen in front of the phone UI;
// the close button and the back gesture both return to the thread, which keeps its draft.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

const noOverflow = async (page: import('@playwright/test').Page) => {
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
}

test('phone: a tap on an attachment opens the viewer full screen; x and back close it', async ({ page, minbox }) => {
  test.setTimeout(120_000)
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'kinds')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'kinds')
  await expectTerminal(page, /sent kinds in thr_\w+ 8/)
  await typeInTerminal(page, 'attach')
  await expectTerminal(page, /sent attach in thr_/)

  const tap = async (loc: import('@playwright/test').Locator) => {
    await loc.scrollIntoViewIfNeeded()
    const b = (await loc.boundingBox())!
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2)
  }
  const phone = page.getByTestId('phone')
  const viewer = page.getByTestId('attachment-viewer')
  await page.getByTestId('mobile-back').click()
  await expect(phone).toHaveAttribute('data-screen', 'home')
  await tap(page.getByTestId('thread-row').filter({ hasText: 'Many kinds' }))
  await expect(phone).toHaveAttribute('data-screen', 'thread')
  const reply = page.getByTestId('reply-box')
  await reply.fill('half-written reply')

  const fullScreen = async () => {
    await expect(viewer).toBeVisible()
    const b = (await viewer.boundingBox())!
    expect(b.x).toBeLessThanOrEqual(1)
    expect(b.width).toBeGreaterThanOrEqual(388)
    expect(b.height).toBeGreaterThanOrEqual(780)
    await noOverflow(page)
    const c = (await page.getByTestId('close-file').boundingBox())!
    expect(c.x + c.width).toBeLessThanOrEqual(391)
    expect(c.width).toBeGreaterThanOrEqual(40)
  }

  // image: tap the thumbnail
  await tap(page.getByRole('button', { name: /View pic\.png/ }))
  await expect(viewer).toHaveAttribute('data-type', 'image')
  await fullScreen()
  await expect(viewer.getByTestId('image-view')).toBeVisible()
  // the annotation panel is a bottom sheet behind a button, inside the screen
  await tap(page.getByTestId('comments-toggle'))
  const sheet = (await page.getByTestId('comments-sheet').boundingBox())!
  expect(sheet.x).toBeGreaterThanOrEqual(0)
  expect(sheet.x + sheet.width).toBeLessThanOrEqual(391)
  await tap(page.getByTestId('comments-toggle'))
  // x closes
  await tap(page.getByTestId('close-file'))
  await expect(viewer).toHaveCount(0)
  await expect(phone).toHaveAttribute('data-screen', 'thread')
  await expect(reply).toHaveValue('half-written reply')

  // back gesture closes
  await tap(page.getByRole('button', { name: /View pic\.png/ }))
  await fullScreen()
  await page.goBack()
  await expect(viewer).toHaveCount(0)
  await expect(phone).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('thread-view')).toContainText('Files of every kind')
  await expect(reply).toHaveValue('half-written reply')

  // html page and code
  await tap(page.getByRole('button', { name: /Open page\.html/ }))
  await expect(viewer).toHaveAttribute('data-type', 'html')
  await fullScreen()
  await tap(page.getByTestId('close-file'))
  await expect(viewer).toHaveCount(0)
  await tap(page.getByRole('button', { name: /Open main\.go/ }))
  await expect(viewer).toHaveAttribute('data-type', 'code')
  await fullScreen()
  await expect(viewer.getByTestId('code')).toBeVisible()
  await tap(page.getByTestId('close-file'))
  await expect(viewer).toHaveCount(0)
  // no history loop: one back leaves the thread for the list
  await page.goBack()
  await expect(phone).toHaveAttribute('data-screen', 'home')

  // markdown page
  await tap(page.getByTestId('thread-row').filter({ hasText: 'The plan' }))
  await tap(page.getByRole('button', { name: /Open plan\.md/ }))
  await expect(viewer).toBeVisible()
  await fullScreen()
  await expect(viewer).toContainText('Archive plan')
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
})

// Not a check: screenshots for docs/ui-v2-threads.md (SCREENSHOTS=1 SCREENSHOT_DIR=docs/img/v2).
test('screenshots: phone attachment viewer', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  test.setTimeout(120_000)
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  const shot = async (name: string) => {
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${out}/${name}.png` })
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'kinds')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'kinds')
  await expectTerminal(page, /sent kinds in thr_\w+ 8/)
  await typeInTerminal(page, 'attach')
  await expectTerminal(page, /sent attach in thr_/)
  await page.getByTestId('mobile-back').click()
  await page.getByTestId('thread-row').filter({ hasText: 'Many kinds' }).click()
  await page.getByRole('button', { name: /View pic\.png/ }).click()
  await expect(page.getByTestId('image-view')).toBeVisible()
  await shot('ph-viewer-image')
  await page.goBack()
  await page.goBack()
  await page.getByTestId('thread-row').filter({ hasText: 'The plan' }).click()
  await page.getByRole('button', { name: /Open plan\.md/ }).click()
  await expect(page.getByTestId('attachment-viewer')).toContainText('Archive plan')
  await shot('ph-viewer-markdown')
})

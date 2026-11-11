import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Phone (touch, 390x844): the reply composer is one compact row (+ actions, text box, send); expand, attach
// and draw live in the + menu.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('phone: the empty reply composer is one line high and the + menu holds the actions', async ({ page, minbox }) => {
  test.setTimeout(120_000)
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'composer')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say hello there')
  await page.getByTestId('mobile-back').click()
  const row = (await page.getByTestId('thread-row').first().boundingBox())!
  await page.touchscreen.tap(row.x + row.width / 2, row.y + row.height / 2)

  const box = page.getByTestId('reply-box')
  const send = page.getByTestId('reply-send')
  const actions = page.getByTestId('reply-actions')
  await expect(box).toBeVisible()
  const h = (await box.boundingBox())!.height
  expect(h).toBeLessThan(40)
  expect((await send.boundingBox())!.height).toBeLessThan(52)
  expect((await actions.boundingBox())!.height).toBeLessThan(52)
  await expect(send).toBeDisabled()
  // The actions are not stacked inside the box any more.
  await expect(page.getByTestId('attach-files')).toHaveCount(0)

  // The menu: three actions, expand toggles the full-height editor.
  await actions.click()
  await expect(page.getByTestId('attach-files')).toBeVisible()
  await expect(page.getByTestId('compose-draw')).toBeVisible()
  await expect(page.getByTestId('reply-full')).toBeVisible()
  await page.getByTestId('reply-full').click()
  await expect(page.getByTestId('reply-full')).toHaveCount(0)
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan(200)
  await box.fill('typed in the big editor')
  await actions.click()
  await expect(page.getByTestId('reply-full')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('reply-full').click()
  await expect.poll(async () => (await box.boundingBox())!.height).toBeLessThan(80)

  // Draw opens the sketcher.
  await actions.click()
  await page.getByTestId('compose-draw').click()
  await expect(page.getByTestId('sketch-modal')).toBeVisible()
  await page.getByTestId('sketch-cancel').click()

  // The box grows with the text; send is enabled; ! switches the label to Run.
  await box.fill('one\ntwo\nthree\nfour')
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan(h + 40)
  await expect(send).toBeEnabled()
  await box.fill('!echo hi')
  await expect(send).toHaveAttribute('aria-label', 'Run')
  await box.fill('')
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
})

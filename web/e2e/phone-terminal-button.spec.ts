import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Phone (touch, 390x844): the thread header has a terminal icon button (no envelope); mark unread
// lives in the "..." menu; the way back from the terminal is the back button / Thread tab.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

test('phone: the terminal icon in the thread header opens the terminal, back returns; mark unread is in the menu', async ({ page, minbox }) => {
  test.setTimeout(120_000)
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  const tap = async (id: string) => {
    const b = (await page.getByTestId(id).boundingBox())!
    expect(b.width).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2)
  }
  const phone = page.getByTestId('phone')
  await page.getByTestId('mobile-back').click()
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(phone).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByRole('button', { name: 'Mark unread' })).toHaveCount(0)
  await expect(page.getByTestId('phone-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('phone-thread-subject')).toHaveText('Pick a database')
  if (process.env.SCREENSHOTS === '1') await page.screenshot({ path: `${process.env.SCREENSHOT_DIR ?? 'test-results'}/th-phone-header.png` })

  await tap('thread-open-terminal')
  await expect(phone).toHaveAttribute('data-screen', 'terminal')
  await tap('mobile-back')
  await expect(phone).toHaveAttribute('data-screen', 'thread')

  await tap('thread-more')
  await page.getByTestId('thread-unread').tap()
  await expect(phone).toHaveAttribute('data-screen', 'home')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Pick a database' })).toBeVisible()
})

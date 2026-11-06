import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// A button that opens a menu also closes it: mouse, keyboard; outside click and item click still work.

test('pressing the opening button again closes the menu', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await page.getByTestId('thread-list').getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()

  const menu = page.getByRole('menu')
  for (const id of ['thread-more', 'session-menu']) {
    const btn = page.getByTestId(id).first()
    // Mouse.
    await btn.click()
    await expect(menu).toBeVisible()
    await btn.click()
    await expect(menu).toHaveCount(0)
    // And it opens again afterwards.
    await btn.click()
    await expect(menu).toBeVisible()
    await btn.click()
    await expect(menu).toHaveCount(0)
    // Keyboard.
    await btn.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    // Outside click closes.
    await btn.click()
    await expect(menu).toBeVisible()
    await page.mouse.click(5, 300)
    await expect(menu).toHaveCount(0)
  }

  // An item still works.
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-mark-finished').click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('thread-view').getByTestId('thread-status')).toHaveAttribute('data-status', 'finished')
})

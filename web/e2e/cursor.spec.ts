import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'
import type { Locator } from '@playwright/test'

const cursorOf = (l: Locator) => l.evaluate((el) => getComputedStyle(el).cursor)

// Clickable rows, and the text inside them, show the pointer, never the I-beam.
test('clickable rows, their text and menu items use the pointer cursor', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'work')
  await expectTerminal(page, 'ready>')

  await typeInTerminal(page, 'say Hello note')
  await expectTerminal(page, /sent .*thr_/)
  await expect(page.getByTestId('thread-row').first()).toBeVisible()
  const row = page.getByTestId('thread-row').first()
  expect(await cursorOf(row)).toBe('pointer')
  expect(await cursorOf(row.locator('span.truncate').first())).toBe('pointer')

  const item = page.getByTestId('project-item').first()
  expect(await cursorOf(item.getByTestId('project-select'))).toBe('pointer')
  expect(await cursorOf(item.getByTestId('project-name'))).toBe('pointer')

  await item.hover()
  await item.getByTestId('project-menu').click()
  expect(await cursorOf(page.getByTestId('project-rename'))).toBe('pointer')
  await page.keyboard.press('Escape')

  await page.getByTestId('session-filter').click()
  const opt = page.getByTestId('session-option').first()
  expect(await cursorOf(opt)).toBe('pointer')
  expect(await cursorOf(opt.locator('span.truncate').first())).toBe('pointer')
})

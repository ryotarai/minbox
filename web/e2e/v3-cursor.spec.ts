// Main's cursor.spec on v3: clickable rows, the text inside them, buttons and menu items show the
// arrow (a native app's cursor), never the pointing hand or the I-beam.
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { say, startAgent, taskNamed } from './v3'

const cursorOf = (l: Locator) => l.evaluate((el) => getComputedStyle(el).cursor)

test('agent rows, task rows, their text, buttons and menu items use the default arrow cursor', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'work')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, 'Fix the gauge reading')
  await page.goto(minbox.url)
  const row = page.getByTestId('agent-row').first()
  expect(await cursorOf(row)).toBe('default')
  expect(await cursorOf(row.locator('.v-nm'))).toBe('default')
  const task = page.locator(`[data-testid="task-row"][data-task="${t.id}"] .v-line`)
  await expect(task).toBeVisible()
  expect(await cursorOf(task)).toBe('default')
  expect(await cursorOf(task.locator('.v-t').first())).toBe('default')
  expect(await cursorOf(page.getByTestId('nav-board'))).toBe('default')

  const item = page.getByTestId('project-item').first()
  expect(await cursorOf(item.getByTestId('project-select'))).toBe('default')
  await row.click({ button: 'right' })
  expect(await cursorOf(page.getByTestId('menu-rename'))).toBe('default')
  await page.keyboard.press('Escape')
  await row.click()
  expect(await cursorOf(page.getByTestId('agent-menu'))).toBe('default')
  expect(await cursorOf(page.getByTestId('terminal-toggle'))).toBe('default')
})

import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test } from './fixtures'

const luminance = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).map(Number)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}
const termBg = (page: Page) => page.getByTestId('terminal').evaluate((e) => getComputedStyle(e.parentElement!.parentElement!).backgroundColor)

test('the terminal follows the app theme, live', async ({ page, minbox }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'tt')
  await expectTerminal(page, 'ready>')
  const host = page.getByTestId('terminal')
  await expect(host).toHaveAttribute('data-term-theme', 'dark')
  expect(luminance(await termBg(page))).toBeLessThan(0.2)

  // Switch through the theme setting, then come back to the terminal: no reload.
  await page.getByTestId('list-options').click()
  await page.getByTestId('open-settings').click()
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByTestId('settings-back').click()
  await expect(host).toHaveAttribute('data-term-theme', 'light')
  await expect(host).toHaveAttribute('data-term-bg', '#ffffff')
  expect(luminance(await termBg(page))).toBeGreaterThan(0.7)

  // A change of the html attribute alone (what a system preference change does) is followed too.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await expect(host).toHaveAttribute('data-term-theme', 'dark')
  expect(luminance(await termBg(page))).toBeLessThan(0.2)
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
  await expect(host).toHaveAttribute('data-term-theme', 'light')

  // The connection survived: the terminal still answers.
  await expectTerminal(page, 'ready>')
})

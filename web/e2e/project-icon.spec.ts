import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSession, expect, expectTerminal, test } from './fixtures'

// A project can have an icon (an emoji or an uploaded image): in the 56 px rail tile (below 1400 px),
// before the name in the wide rail row, and removed again with "Remove icon".

// A 1x1 red PNG; the server crops it square and scales it to 128x128.
const RED = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('a project gets an emoji or an image icon, shown in the rail tile and the wide row; remove restores the initials', async ({ page, minbox }) => {
  const dir = join(minbox.dataDir, 'iconproj')
  mkdirSync(dir, { recursive: true })
  await page.setViewportSize({ width: 1200, height: 800 })
  await page.goto(minbox.url)
  await createSession(page, dir, 'alpha')
  await expectTerminal(page, 'ready>')
  const rail = page.getByTestId('project-rail')
  await expect(rail).toHaveAttribute('data-mode', 'tiles')
  const item = rail.getByTestId('project-item').first()
  await expect(item).toContainText('IC')
  await expect(item.getByTestId('project-icon')).toHaveCount(0)

  // Emoji, via the dialog (right-click menu in tile mode).
  await item.click({ button: 'right' })
  await page.getByTestId('project-icon-set').click()
  await expect(page.getByRole('dialog', { name: 'Project icon' })).toBeVisible()
  await page.getByRole('button', { name: '🚀' }).click()
  await page.getByTestId('project-icon-save').click()
  await expect(item.getByTestId('project-icon')).toHaveText('🚀')
  await expect(item).not.toContainText('IC')

  // Wide rail: a small icon before the name.
  await page.setViewportSize({ width: 1600, height: 900 })
  await expect(rail).toHaveAttribute('data-mode', 'names')
  await expect(item.getByTestId('project-icon')).toHaveText('🚀')
  await expect(item.getByTestId('project-name')).toBeVisible()

  // Image upload: an <img> that loads.
  await item.hover()
  await item.getByTestId('project-menu').click()
  await page.getByTestId('project-icon-set').click()
  await page.getByTestId('project-icon-file').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: RED })
  await expect(page.getByTestId('project-icon-preview').locator('img')).toBeVisible()
  await page.getByTestId('project-icon-save').click()
  const img = item.locator('img[data-testid="project-icon"]')
  await expect(img).toHaveAttribute('src', /\/api\/projects\/.+\/icon\?v=\d+/)
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(128)

  // The same in the tile.
  await page.setViewportSize({ width: 1200, height: 800 })
  await expect(rail).toHaveAttribute('data-mode', 'tiles')
  await expect(item.locator('img[data-testid="project-icon"]')).toBeVisible()
  const box = await item.locator('img[data-testid="project-icon"]').boundingBox()
  expect(box?.width).toBeCloseTo(32, 0)

  // Remove restores the initials.
  await item.click({ button: 'right' })
  await page.getByTestId('project-icon-set').click()
  await page.getByTestId('project-icon-remove').click()
  await expect(item.getByTestId('project-icon')).toHaveCount(0)
  await expect(item).toContainText('IC')
})

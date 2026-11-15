import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// ⌘K "New thread": there is no New message screen; the thread list's compose box takes the focus,
// aimed at the current session.

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function newThread(page: Page) {
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await page.getByTestId('palette-input').fill('>new thread')
  const item = page.locator('[data-testid="palette-item"][data-id="new-thread"]')
  await expect(item).toBeVisible()
  await item.click()
  await expect(page.getByTestId('palette')).toHaveCount(0)
}

test('⌘K New thread focuses the list compose box, aimed at the current session', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  // Old New message drafts are dropped on load.
  await page.evaluate(() => {
    localStorage.setItem('minbox:compose-drafts', JSON.stringify([{ id: 'c1', session_id: 'x', subject: 'Old draft', body: 'b', name: '', updated: 1 }]))
    localStorage.setItem('minbox:files:compose:c1', '[]')
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => [localStorage.getItem('minbox:compose-drafts'), localStorage.getItem('minbox:files:compose:c1')])).toEqual([null, null])

  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await createSession(page, minbox.dataDir, 'beta')
  await expectTerminal(page, 'ready>')
  // Aim the box elsewhere first, and move the focus away from it.
  await page.getByTestId('composer-target').click()
  await page.getByTestId('session-option').filter({ hasText: 'alpha' }).click()
  await expect(page.getByTestId('composer-target-name')).toHaveText('alpha')
  await page.getByTestId('terminal').click()

  await newThread(page)
  await expect(page.getByTestId('quick-body')).toBeFocused()
  await expect(page.getByTestId('composer-target-name')).toHaveText('beta')
  await expect(page.getByRole('dialog', { name: 'New message' })).toHaveCount(0)
  await page.keyboard.type('Started from the palette')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(page.getByTestId('thread-subject')).toHaveText('Started from the palette')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')

  // Drafts lists no New message drafts.
  await page.getByTestId('drafts').first().click()
  await expect(page.getByRole('dialog', { name: 'Drafts' })).toBeVisible()
  await expect(page.getByText('Old draft')).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('phone: ⌘K New thread from an open thread goes back to the list and focuses its compose box', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'gamma')
    await expectTerminal(page, 'ready>')
    await typeInTerminal(page, 'say hello there')
    await page.getByTestId('mobile-back').click()
    await page.getByTestId('thread-row').first().click()
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')

    await newThread(page)
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
    await expect(page.getByTestId('quick-body')).toBeFocused()
    await expect(page.getByTestId('composer-target-name')).toHaveText('gamma')
  })
})

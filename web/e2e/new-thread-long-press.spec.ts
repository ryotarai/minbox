import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Long-pressing the reply box's send button opens "New thread" (docs/ui-v2-threads.md).

async function openThread(page: Page, dir: string) {
  await createSession(page, dir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
}

async function openPhone(page: Page, minbox: { url: string; dataDir: string }) {
  await page.goto(minbox.url)
  await openThread(page, minbox.dataDir)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
}

/** Hold the pointer on the button for ms, then release. */
async function hold(page: Page, ms: number, button: 'left' | 'right' = 'left') {
  const box = (await page.getByTestId('reply-send').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down({ button })
  await page.waitForTimeout(ms)
  await page.mouse.up({ button })
}

test('long press on send opens the new-thread dialog (phone)', async ({ page, minbox }) => {
  await openPhone(page, minbox)
  const box = page.getByTestId('reply-box')
  const rows = page.getByTestId('thread-row')

  // A normal tap still sends.
  await box.fill('plain reply')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('message').filter({ hasText: 'plain reply' })).toHaveCount(1)
  await expect(box).toHaveValue('')

  // A long press opens the dialog, prefilled, and does not send.
  await box.fill('Start something new')
  await hold(page, 700)
  const dlg = page.getByTestId('new-thread-dialog')
  await expect(dlg).toBeVisible()
  await expect(page.getByTestId('new-thread-body')).toHaveValue('Start something new')
  await expect(page.getByTestId('new-thread-session')).toContainText('alpha (this session)')
  await expect(box).toHaveValue('Start something new')
  await expect(page.getByTestId('message').filter({ hasText: 'Start something new' })).toHaveCount(0)

  // Cancel does nothing.
  await page.getByTestId('new-thread-cancel').click()
  await expect(dlg).toHaveCount(0)
  await expect(box).toHaveValue('Start something new')

  // A short press cancels the long press: it sends.
  await hold(page, 100)
  await expect(dlg).toHaveCount(0)
  await expect(page.getByTestId('message').filter({ hasText: 'Start something new' })).toHaveCount(1)
  await expect(box).toHaveValue('')

  // "!" is refused inline, "\!" is fine.
  await box.fill('Make it so')
  await hold(page, 700)
  await page.getByTestId('new-thread-body').fill('!ls')
  await expect(page.getByTestId('new-thread-cmd')).toBeVisible()
  await expect(page.getByTestId('new-thread-create')).toBeDisabled()
  await page.getByTestId('new-thread-body').fill('Brand new thread text')
  await expect(page.getByTestId('new-thread-create')).toBeEnabled()
  await page.getByTestId('new-thread-create').click()
  await expect(dlg).toHaveCount(0)
  // The text was edited in the dialog, so the draft stays; no navigation.
  await expect(box).toHaveValue('Make it so')
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
  await expect(page.getByText('Thread created')).toBeVisible()
  await page.getByTestId('undo').click()
  await expect(page.getByTestId('thread-view')).toContainText('Brand new thread text')
  await page.goBack()
  void rows
})

test('right-click and a mouse hold on send open the dialog; Create makes a thread in the list (desktop)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await openThread(page, minbox.dataDir)
  const box = page.getByTestId('reply-box')
  await expect(page.getByTestId('reply-send')).toHaveAttribute('title', 'Hold to start a new thread')

  await box.fill('From right click')
  await hold(page, 50, 'right')
  const dlg = page.getByTestId('new-thread-dialog')
  await expect(dlg).toBeVisible()
  await expect(page.getByTestId('new-thread-body')).toHaveValue('From right click')
  await page.getByTestId('new-thread-cancel').click()
  await expect(dlg).toHaveCount(0)
  await expect(page.getByTestId('message').filter({ hasText: 'From right click' })).toHaveCount(0)

  // Create: unchanged draft is used, so the box empties; the new thread shows in the list.
  await hold(page, 700)
  await expect(page.getByTestId('new-thread-body')).toHaveValue('From right click')
  await page.getByTestId('new-thread-create').click()
  await expect(dlg).toHaveCount(0)
  await expect(box).toHaveValue('')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'From right click' })).toHaveCount(1)
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
  await expectTerminal(page, /From right click/)
})

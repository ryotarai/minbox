// Attachments and quoting in the v3 reply boxes (as in the thread view before v3): paste an image,
// or pick files with the attach button (the photo / file picker on a phone); tiles show the upload,
// the sent message carries the files. Select text in a message: Reply (or R) quotes it into the box.
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function paste(page: Page, testid: string) {
  await page.getByTestId(testid).getByTestId('composer-text').evaluate((el, b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, PNG.toString('base64'))
}

test('stream: paste an image and attach a file with the button; the message carries both', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const box = page.getByTestId('composer')
  await paste(page, 'composer')
  await page.getByTestId('attach-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello notes') })
  await expect(box.getByTestId('compose-file')).toHaveCount(2)
  await expect(box.locator('[data-testid="compose-file"][data-state="done"]')).toHaveCount(2)
  await box.getByTestId('composer-text').fill('see the screenshot')
  await box.getByTestId('composer-send').click()
  await expect(box.getByTestId('compose-file')).toHaveCount(0)
  const sent = page.locator('[data-testid="v3-message"][data-author="user"]').filter({ hasText: 'see the screenshot' })
  await expect(sent.getByTestId('attachment-card')).toHaveCount(2)
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  const m = s.messages.find((x: any) => x.words === 'see the screenshot')
  expect(m.attachments.map((x: any) => x.name).sort()).toEqual(expect.arrayContaining(['notes.txt']))
  expect(m.attachments).toHaveLength(2)
})

test('task view: a file only (no words) is sent about the task', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.goto(`${minbox.url}/#v=task&k=${t.id}`)
  const box = page.getByTestId('task-composer')
  await paste(page, 'task-composer')
  await expect(box.locator('[data-testid="compose-file"][data-state="done"]')).toHaveCount(1)
  await box.getByTestId('composer-send').click()
  await expect(page.getByTestId('task-view').locator('[data-testid="v3-message"][data-author="user"]').getByTestId('attachment-card').first()).toBeVisible()
  const d = await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)
  expect(d.messages.some((m: any) => m.author === 'user' && m.attachments?.length === 1)).toBe(true)
})

test('quote: select text in a reply, Reply puts it in the box as a quote; R does too', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'is the staging server up?')
  const r = await agentReply(minbox, a, /Sure — noted/)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const body = page.locator(`[data-testid="v3-message"][data-message-id="${r.id}"] .v-bd`)
  await body.locator('p').first().selectText()
  await page.getByTestId('quote-reply').click()
  await expect(page.getByTestId('composer-text')).toHaveValue(/^> Sure/)
  await expect(page.getByTestId('composer-text')).toBeFocused()
  await page.getByTestId('composer-text').fill('')
  await page.locator('body').click({ position: { x: 700, y: 30 } })
  await body.locator('p').first().selectText()
  await page.keyboard.press('r')
  await expect(page.getByTestId('composer-text')).toHaveValue(/^> Sure/)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the photo / file picker attaches to the reply', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
    await expect(page.getByTestId('attach-files')).toContainText('Photo / file')
    await page.getByTestId('attach-input').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG })
    const box = page.getByTestId('composer')
    await expect(box.locator('[data-testid="compose-file"][data-state="done"]')).toHaveCount(1)
    await box.getByTestId('composer-send').tap()
    await expect(page.locator('[data-testid="v3-message"][data-author="user"]').getByTestId('attachment-card').first()).toBeVisible()
  })
})

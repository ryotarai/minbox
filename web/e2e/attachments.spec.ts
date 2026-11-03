import { writeFileSync } from 'node:fs'
import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// Attachments like Plannotator Inbox: every kind in its viewer, comments that
// go back in the reply, the body's diagrams/pages/images/links, and files the
// person attaches.

const joined = async (page: import('@playwright/test').Page) => (await terminalText(page)).replace(/\n/g, '')

test('each kind of attached file opens in its own viewer; a code line comment reaches Claude', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'kinds')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'kinds')
  await expectTerminal(page, /sent kinds in thr_\w+ 8/)
  await page.getByTestId('thread-row').filter({ hasText: 'Many kinds' }).click()

  const cards = page.getByTestId('attachment-card')
  await expect(cards).toHaveCount(8)
  await expect(page.getByTestId('image-gallery')).toContainText('pic.png')
  // PDFs and other files download.
  await expect(page.getByRole('link', { name: 'Download doc.pdf' })).toHaveAttribute('download', 'doc.pdf')
  await expect(page.getByRole('link', { name: 'Download blob.bin' })).toBeVisible()

  const viewer = page.getByTestId('attachment-viewer')
  const open = async (name: string) => {
    await page.getByRole('button', { name: new RegExp(`(Open|View) ${name.replace('.', '\\.')}`) }).click()
    await expect(viewer.getByRole('tab', { selected: true })).toHaveText(name)
  }
  await open('data.json')
  await expect(viewer).toHaveAttribute('data-type', 'text')
  await expect(viewer.getByTestId('code')).toContainText('"a": 1')

  await open('page.html')
  await expect(viewer).toHaveAttribute('data-type', 'html')
  await expect(viewer.frameLocator('[data-testid="html-view"]').locator('#t')).toHaveText('Mock page')

  await open('flow.mmd')
  await expect(viewer.getByTestId('diagram').locator('svg')).toBeVisible({ timeout: 20_000 })
  await open('graph.dot')
  await expect(viewer.getByTestId('diagram').locator('svg')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: /View pic\.png/ }).click()
  await expect(viewer).toHaveAttribute('data-type', 'image')
  await expect(viewer.getByTestId('image-view')).toBeVisible()

  await open('main.go')
  await expect(viewer).toHaveAttribute('data-type', 'code')
  await viewer.getByTestId('code-line-number').nth(2).dispatchEvent('mousedown')
  await viewer.getByTestId('code-line-number').nth(2).dispatchEvent('mouseup')
  await page.getByTestId('annotation-input').fill('Use fmt here.')
  await page.getByTestId('annotation-save').click()
  await expect(viewer.getByTestId('annotation')).toContainText('line 3')

  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
  await page.getByTestId('close-file').click()
  await expect.poll(() => joined(page), { timeout: 15_000 }).toContain('# Feedback on the attached files')
  expect(await joined(page)).toContain('(line 3) Feedback on: "func main() {"')
  expect(await joined(page)).toContain('> Use fmt here.')
})

test('the body draws diagrams and pages, shows its images, and its links to attached files open beside', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'rich')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'rich')
  await expectTerminal(page, /sent rich in thr_\w+ not_shown=0/)
  await page.getByTestId('thread-row').filter({ hasText: 'Rich body' }).click()
  const msg = page.getByTestId('message').filter({ hasText: 'A diagram' })
  await expect(msg.getByTestId('diagram').locator('svg')).toBeVisible({ timeout: 20_000 })
  const embed = msg.getByTestId('html-embed')
  await expect(embed).toContainText('HTML · sandboxed')
  await expect(embed.frameLocator('iframe').locator('#chart')).toHaveText('Live chart', { timeout: 15_000 })
  const img = msg.locator('img.mb-inline-img')
  await expect(img).toHaveAttribute('src', /\/api\/messages\/msg_\w+\/image\?path=shot\.png/)
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(4)
  await expect(msg.getByText('missing')).toHaveAttribute('title', 'Not attached to this message')
  await msg.getByText('the plan').click()
  await expect(page.getByTestId('attachment-viewer')).toContainText('Do it.')
})

test('the person attaches files to a reply; Claude reads them as Attached lines', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'files')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Need the notes')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).click()
  const file = `${minbox.dataDir}/notes.txt`
  writeFileSync(file, 'my notes\n')
  await page.getByTestId('attach-input').setInputFiles(file)
  await expect(page.getByTestId('compose-file')).toHaveAttribute('data-state', 'done')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
  await expect.poll(() => joined(page), { timeout: 15_000 }).toMatch(/Attached: notes\.txt \(\/.*uploads\/att_\w+\/notes\.txt\)/)
  // The person's own message shows the file.
  await expect(page.getByTestId('message').filter({ hasText: 'You' }).getByTestId('attachment-card')).toContainText('notes.txt')
})

test('a long paste becomes a file, and Undo puts it back in the box', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'paste')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Paste the log')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).click()
  const box = page.getByTestId('reply-box')
  await box.click()
  await page.evaluate(() => {
    const text = 'first line of the log\n' + 'x'.repeat(40 * 1024)
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    document.querySelector('[data-testid="reply-box"]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  const tile = page.getByTestId('compose-file')
  await expect(tile).toContainText('first line of the log')
  await expect(tile).toHaveAttribute('data-state', 'done')
  await expect(box).toHaveValue('')
  await tile.getByTestId('put-back').click()
  await expect(tile).toHaveCount(0)
  await expect(box).toHaveValue(/^first line of the log\nx{100}/)
})

test('Artifacts lists every file of the thread, newest message first', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'arts')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'kinds')
  await expectTerminal(page, /sent kinds/)
  await page.getByTestId('thread-row').filter({ hasText: 'Many kinds' }).click()
  await page.getByTestId('artifacts-button').click()
  const grid = page.getByTestId('artifacts')
  await expect(grid).toContainText('8 from 1 message')
  await expect(grid.getByTestId('artifact')).toHaveCount(8)
  await grid.getByRole('button', { name: /^main\.go/ }).click()
  await expect(page.getByTestId('attachment-viewer')).toHaveAttribute('data-type', 'code')
})

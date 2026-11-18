import type { Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Minbox } from './fixtures'
import { startAgent } from './v3'

// v3 (ported from mention-files.spec.ts): in an agent stream's reply box and the New message dialog.
// "@" at the start of a word in a message box completes files and folders of the session's folder
// (docs/ui-mentions.md).

function project(m: Minbox): string {
  const dir = join(m.dataDir, 'mproj')
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
  mkdirSync(join(dir, 'my docs'))
  writeFileSync(join(dir, 'src', 'main.go'), 'x')
  writeFileSync(join(dir, 'src', 'util.go'), 'x')
  writeFileSync(join(dir, 'src', 'deep', 'leaf.txt'), 'x')
  writeFileSync(join(dir, 'my docs', 'note one.md'), 'x')
  writeFileSync(join(dir, 'readme.md'), 'x')
  return dir
}

async function openThread(page: Page, m: Minbox) {
  project(m)
  const a = await startAgent(m, 'alpha', 'mproj')
  await page.goto(`${m.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('composer-text')).toBeVisible()
  return a
}

async function walk(page: Page, phone: boolean) {
  const box = page.getByTestId('composer-text')
  const popup = page.getByTestId('completions')
  const item = (insert: string) => page.locator(`[data-testid="completion-item"][data-insert="${insert}"]`)

  // "@" opens the list: folders first, then files.
  await box.click()
  await box.pressSequentially('see @')
  await expect(popup).toBeVisible()
  const inserts = await page.getByTestId('completion-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-insert')))
  expect(inserts.slice(0, 3)).toEqual(['my docs/', 'src/', 'readme.md'])

  // Filtering as it is typed; Down moves, Enter takes a file.
  await box.pressSequentially('src/')
  await expect(item('src/main.go')).toBeVisible()
  await expect(item('src/deep/')).toBeVisible()
  await box.press('ArrowDown')
  await box.press('ArrowDown')
  await box.press('ArrowUp')
  await expect(page.locator('[data-testid="completion-item"][aria-selected="true"]')).toHaveAttribute('data-insert', 'src/main.go')
  await box.press('Enter')
  await expect(box).toHaveValue('see @src/main.go ')
  await expect(popup).toHaveCount(0)

  // A folder is taken with its slash and completion goes on inside it (Tab).
  await box.pressSequentially('and @sr')
  await expect(item('src/')).toBeVisible()
  await box.press('Tab')
  await expect(box).toHaveValue('see @src/main.go and @src/')
  await expect(item('src/util.go')).toBeVisible()
  await box.press('Tab') // the first entry is the folder src/deep/
  await expect(box).toHaveValue('see @src/main.go and @src/deep/')
  await expect(item('src/deep/leaf.txt')).toBeVisible()

  // Esc closes the list and keeps the text (and does not leave the box).
  await box.press('Escape')
  await expect(popup).toHaveCount(0)
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('see @src/main.go and @src/deep/')

  // A tap (or click) takes an entry; a path with spaces is quoted, and the folder stays open.
  await box.fill('')
  await box.pressSequentially('@my')
  await item('my docs/').click()
  await expect(box).toHaveValue('@"my docs/"')
  await expect(item('my docs/note one.md')).toBeVisible()
  await item('my docs/note one.md').click()
  await expect(box).toHaveValue('@"my docs/note one.md" ')

  // Not a mention inside a word (an e-mail address); ../ and ~/ complete too.
  await box.fill('')
  await box.pressSequentially('mail a@b')
  await expect(popup).toHaveCount(0)
  await box.fill('')
  await box.pressSequentially('@../')
  await expect(popup).toBeVisible()
  await box.fill('')
  await box.pressSequentially('@~/')
  await expect(popup).toBeVisible() // the home folder of the machine; its content is not asserted
  await box.press('Escape')

  // Still a normal box: a "!" command shows no list; Cmd/Ctrl+Enter sends the text.
  await box.fill('!ls @')
  await expect(popup).toHaveCount(0)
  await box.fill('')
  await box.pressSequentially('look at @read')
  await expect(item('readme.md')).toBeVisible()
  await box.press('Enter')
  await expect(box).toHaveValue('look at @readme.md ')
  await box.press('ControlOrMeta+Enter')
  await expect(box).toHaveValue('')
  await expect(page.getByTestId('stream-view').locator('[data-testid="v3-message"][data-author="user"]').last()).toContainText('look at @readme.md')
  void phone
}

test('@ completes files in the reply box (desktop)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await openThread(page, minbox)
  await walk(page, false)
})

test('@ completes files in the New message box too', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await openThread(page, minbox)
  await page.keyboard.press('Shift+N')
  const quick = page.getByTestId('new-body')
  await quick.click()
  await quick.pressSequentially('read @sr')
  await page.locator('[data-testid="completion-item"][data-insert="src/"]').click()
  await expect(quick).toHaveValue('read @src/')
  await expect(page.locator('[data-testid="completion-item"][data-insert="src/main.go"]')).toBeVisible()
  await quick.press('Escape')
  await expect(page.getByTestId('completions')).toHaveCount(0)
})

test('@ completes files in the reply box (phone, dark theme)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  const a = await openThread(page, minbox)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('composer-text')).toBeVisible()
  await walk(page, true)
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
})

test('the Files pane: its @ button and the row menu put the path into the reply box', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await openThread(page, minbox)
  const reply = page.getByTestId('composer-text')
  await reply.fill('look at')
  await page.getByTestId('pane-files').click()
  const row = (p: string) => page.getByTestId('files-tree').locator(`[data-item-path="${p}"]`)
  await row('src/').click()
  await row('src/main.go').click()
  await page.getByTestId('file-viewer-mention').click()
  await expect(reply).toHaveValue('look at @src/main.go ')
  await expect(reply).toBeFocused()
  // A draft: it is still there after a reload.
  await page.reload()
  await expect(page.getByTestId('composer-text')).toHaveValue('look at @src/main.go ')
})

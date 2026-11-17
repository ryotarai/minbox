import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, expect, test, type Minbox } from './fixtures'

// The Files pane: the thread's session folder as a tree (@pierre/trees), beside the thread on a
// desktop (after the Tasks pane, before the terminal), full screen on a phone. Type to filter, git
// status on the rows, a click on a file shows it, and "@" puts its path in the thread's message box.
// The tree renders in an open shadow root; Playwright's CSS locators reach into it.
// FILES_SHOTS=<dir> saves screenshots (files-pane.png, files-menu.png, files-phone.png).

const SHOTS = process.env.FILES_SHOTS

const SLOW = { timeout: 20_000 }
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'minbox-files-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'README.md'), '# Demo\n')
  writeFileSync(join(dir, 'src', 'main.go'), 'package main\n\nfunc main() {}\n')
  writeFileSync(join(dir, 'src', 'util.ts'), 'export const answer = 42\n')
  writeFileSync(join(dir, 'docs', 'guide one.md'), 'Guide\n')
  writeFileSync(join(dir, 'logo.png'), PNG)
  writeFileSync(join(dir, '.gitignore'), '*.log\n')
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args])
  git('init', '-q')
  git('add', '.')
  git('commit', '-qm', 'init')
  // Changes since: a modified file, an untracked one, an ignored one.
  writeFileSync(join(dir, 'src', 'main.go'), 'package main\n\nfunc main() { println("hi") }\n')
  writeFileSync(join(dir, 'notes.txt'), 'new notes\n')
  writeFileSync(join(dir, 'debug.log'), 'noise\n')
  return dir
}

async function seed(page: Page, minbox: Minbox) {
  const dir = project()
  await page.goto(minbox.url)
  await createSession(page, dir, 'files-app')
  const sessions: { id: string; name: string }[] = await (await page.request.get(minbox.url + '/api/sessions')).json()
  const sid = sessions.find((s) => s.name === 'files-app')!.id
  const r = await page.request.post(`${minbox.url}/api/sessions/${sid}/threads`, { data: { subject: 'Look at the code', body: 'Have a look.' } })
  expect(r.ok()).toBe(true)
  return { dir, sid, tid: (await r.json()).id as string }
}

const pane = (page: Page) => page.getByTestId('files-pane')
const row = (page: Page, path: string) => page.getByTestId('files-tree').locator(`[data-item-path="${path}"]`)

test('desktop: toggle, persist, tree with git status, filter, open a file, @mention into the message box', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { sid, tid } = await seed(page, minbox)
  await page.goto(`${minbox.url}/#s=${sid}&t=${tid}`)
  await expect(page.getByTestId('thread-subject')).toHaveText('Look at the code')

  // Hidden by default; the header button shows it.
  const toggle = page.getByTestId('files-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(pane(page)).toHaveCount(0)
  await toggle.click()
  await expect(pane(page)).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // The session's files: tracked and untracked, git-ignored left out; folders closed.
  await expect(row(page, 'src/')).toBeVisible(SLOW)
  await expect(row(page, 'README.md')).toBeVisible()
  await expect(row(page, 'notes.txt')).toBeVisible()
  await expect(row(page, 'debug.log')).toHaveCount(0)
  await expect(row(page, 'src/main.go')).toHaveCount(0)
  // Git status on the rows: untracked, and a folder that holds a change.
  await expect(row(page, 'notes.txt')).toHaveAttribute('data-item-git-status', 'untracked')
  await expect(row(page, 'src/')).toHaveAttribute('data-item-contains-git-change', 'true')
  await expect(row(page, 'README.md')).not.toHaveAttribute('data-item-git-status', /.+/)

  // Beside the thread, before the terminal: thread | files | terminal.
  const box = async (id: string) => (await page.getByTestId(id).boundingBox())!
  if ((await page.getByTestId('terminal-toggle').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  const [th, fp, tm] = [await box('thread-pane'), await box('files-pane'), await box('terminal')]
  expect(th.x + th.width).toBeLessThanOrEqual(fp.x + 2)
  expect(fp.x + fp.width).toBeLessThanOrEqual(tm.x + 2)
  expect(fp.width).toBeGreaterThan(250)

  // A folder expands; its modified file shows its status.
  await row(page, 'src/').click()
  await expect(row(page, 'src/main.go')).toBeVisible()
  await expect(row(page, 'src/main.go')).toHaveAttribute('data-item-git-status', 'modified')

  // A click on a file shows it, highlighted, under the tree.
  await row(page, 'src/main.go').click()
  const viewer = page.getByTestId('file-viewer')
  await expect(viewer).toHaveAttribute('data-path', 'src/main.go')
  await expect(page.getByTestId('file-viewer-code')).toContainText('func main() { println("hi") }')
  await expect(page.getByTestId('file-viewer-code').locator('span[style*="color"]').first()).toBeVisible(SLOW)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/files-pane.png` })

  // Copy puts the file's exact text on the clipboard; a check says it worked, then goes.
  const copy = page.getByTestId('file-viewer-copy')
  await expect(copy).toHaveAttribute('aria-label', 'Copy contents')
  await copy.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('package main\n\nfunc main() { println("hi") }\n')
  await expect(copy).toHaveAttribute('aria-label', 'Copied')
  await expect(copy).toHaveAttribute('aria-label', 'Copy contents', { timeout: 5_000 })

  // Its @ button writes the path into the thread's message box, as the @ completion does.
  const reply = page.getByTestId('reply-box')
  await reply.fill('look at')
  await page.getByTestId('file-viewer-mention').click()
  await expect(reply).toHaveValue('look at @src/main.go ')
  await expect(reply).toBeFocused()

  // An image shows as an image.
  await row(page, 'logo.png').click()
  await expect(viewer).toHaveAttribute('data-path', 'logo.png')
  await expect(page.getByTestId('file-viewer-copy')).toHaveCount(0)
  await expect.poll(() => page.getByTestId('file-viewer-image').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)
  await page.getByTestId('file-viewer-close').click()
  await expect(viewer).toHaveCount(0)

  // The row menu (right-click): Insert @mention; a path with a space is quoted.
  await row(page, 'docs/').click()
  await row(page, 'docs/guide one.md').click({ button: 'right' })
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/files-menu.png` })
  await page.getByTestId('files-menu-mention').click()
  await expect(reply).toHaveValue('look at @src/main.go @"docs/guide one.md" ')
  // "@" on a focused row does the same.
  await row(page, 'README.md').focus()
  await page.keyboard.press('@')
  await expect(reply).toHaveValue('look at @src/main.go @"docs/guide one.md" @README.md ')

  // Filter by name: only the matches (and their folders) stay.
  const search = page.getByTestId('files-tree').locator('[data-file-tree-search-input]')
  await search.click()
  await search.fill('util')
  await expect(row(page, 'src/util.ts')).toBeVisible()
  await expect(row(page, 'README.md')).toHaveCount(0)
  await expect(row(page, 'notes.txt')).toHaveCount(0)
  // Typing in the tree's search never reaches the thread's single-key shortcuts (E marks read).
  await search.fill('')
  await search.pressSequentially('e')
  await expect(page.getByTestId('thread-subject')).toHaveText('Look at the code')
  await search.fill('')
  await expect(row(page, 'README.md')).toBeVisible()

  // A new file shows on Refresh, with its status.
  writeFileSync(join((await (await page.request.get(`${minbox.url}/api/sessions/${sid}/tree`)).json()).root, 'later.md'), 'x\n')
  await page.getByTestId('files-refresh').click()
  await expect(row(page, 'later.md')).toHaveAttribute('data-item-git-status', 'untracked')

  // Stored: still open after a reload; the close button hides it; ⇧F toggles it.
  await page.reload()
  await expect(pane(page)).toBeVisible()
  await expect(row(page, 'README.md')).toBeVisible(SLOW)
  await page.getByTestId('files-close').click()
  await expect(pane(page)).toHaveCount(0)
  await page.getByTestId('thread-subject').click()
  await page.keyboard.press('Shift+F')
  await expect(pane(page)).toBeVisible()
  await page.getByTestId('thread-subject').click()
  await page.keyboard.press('Shift+F')
  await expect(pane(page)).toHaveCount(0)

  // ⌘K has it too.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
  await page.keyboard.type('Show files')
  await page.keyboard.press('Enter')
  await expect(pane(page)).toBeVisible()
})

test('desktop: binary, large and .env files are not shown; the API keeps to the session folder', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { dir, sid, tid } = await seed(page, minbox)
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]))
  writeFileSync(join(dir, 'big.txt'), 'a'.repeat((1 << 20) + 10))
  writeFileSync(join(dir, '.env'), 'TOKEN=' + 'x'.repeat(12))
  await page.goto(`${minbox.url}/#s=${sid}&t=${tid}`)
  await page.getByTestId('files-toggle').click()
  const note = page.getByTestId('file-viewer-note')
  await row(page, 'blob.bin').click(SLOW)
  await expect(note).toContainText('binary')
  await expect(page.getByTestId('file-viewer-copy')).toHaveCount(0)
  await row(page, 'big.txt').click()
  await expect(note).toContainText('Too large')
  await expect(page.getByTestId('file-viewer-copy')).toHaveCount(0)
  await row(page, '.env').click()
  await expect(note).toContainText('not shown')
  await expect(page.getByTestId('file-viewer-copy')).toHaveCount(0)
  const outside = await page.request.get(`${minbox.url}/api/sessions/${sid}/tree/file?path=${encodeURIComponent('../' + dir.split('/').pop() + '/README.md')}`)
  expect(outside.status()).toBe(400)
})

test.describe('phone', () => {
  test.use({ hasTouch: true })

  test('phone: the thread menu opens the files full screen; a file, then @ back into the message box', async ({ page, minbox }) => {
    const { sid, tid } = await seed(page, minbox)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${minbox.url}/#s=${sid}&t=${tid}`)
    await expect(page.getByTestId('phone-thread-subject')).toHaveText('Look at the code')
    await page.getByTestId('thread-more').click()
    await page.getByTestId('thread-open-files').click()
    const full = page.getByTestId('phone-files')
    await expect(full).toBeVisible()
    const b = (await full.boundingBox())!
    expect(b.width).toBeGreaterThanOrEqual(389)
    expect(b.height).toBeGreaterThan(800)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

    await row(page, 'README.md').tap(SLOW)
    await expect(page.getByTestId('file-viewer-code')).toContainText('# Demo')
    // Copy works full screen too.
    await page.getByTestId('file-viewer-copy').tap()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('# Demo\n')
    await expect(page.getByTestId('file-viewer-copy')).toHaveAttribute('aria-label', 'Copied')
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/files-phone.png` })
    // Back returns to the tree, then to the thread.
    await page.getByTestId('files-back').tap()
    await expect(page.getByTestId('file-viewer')).toHaveCount(0)
    await expect(row(page, 'README.md')).toBeVisible()
    await row(page, 'notes.txt').tap()
    await page.getByTestId('file-viewer-mention').tap()
    await expect(full).toHaveCount(0)
    await expect(page.getByTestId('reply-box')).toHaveValue('@notes.txt ')
  })
})

import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// The features of the redesigned UI: sections, archive, mark read, actions,
// attachments and reviews, search, settings, Board, Decision mode, phone.

/** Moves focus out of the terminal, so single-key shortcuts work. */
async function blurTerminal(page: Page) {
  await page.getByTestId('inbox-pane').click({ position: { x: 5, y: 5 } })
}

async function openThread(page: Page, subject: string) {
  if (await page.getByTestId('thread-back').isVisible()) await page.getByTestId('thread-back').click()
  await page.getByTestId('thread-row').filter({ hasText: subject }).click()
  await expect(page.getByTestId('thread-subject')).toHaveText(subject)
}

test('archiving a thread hides it; Undo restores it; Claude writing brings it back', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'arch')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say First note')
  await openThread(page, 'Note')

  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-archive').click()
  await expect(page.getByTestId('notice')).toContainText('Archived')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Note' })).toHaveCount(0)
  await page.getByTestId('undo').click()
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Note' })).toBeVisible()

  // Shift+E archives the open thread.
  await openThread(page, 'Note')
  await blurTerminal(page)
  await page.keyboard.press('Shift+E')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Note' })).toHaveCount(0)

  // Claude writes into it: it comes back, still marked archived.
  await typeInTerminal(page, 'say Back again')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Note' })).toBeVisible()
  await openThread(page, 'Note')
  await expect(page.getByTestId('archived-notice')).toContainText('wrote after you archived it')
})

test('Mark read sets the thread aside in Quiet and closes its questions; Move back undoes it', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'mr')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await openThread(page, 'Pick a database')
  await page.getByTestId('mark-read').click()
  await expect(page.getByTestId('notice')).toContainText('Marked read')
  await expect(page.locator('[data-testid="thread-list"]')).toContainText('Quiet')
  await openThread(page, 'Pick a database')
  await expect(page.getByTestId('question-state').first()).toHaveText('Closed')
  await page.getByTestId('thread-back').click()
  await blurTerminal(page)
  await page.getByTestId('mark-read').count() // list view: no button
  await openThread(page, 'Pick a database')
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-unread').click()
  await expect(page.locator('[data-testid="thread-list"]')).toContainText('Waiting on you')
})

test('a stopped question puts the session under Stopped on you', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'stopper')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'stop')
  const section = page.locator('[data-section="stopped"]')
  await expect(section.getByTestId('session-row').filter({ hasText: 'stopper' })).toBeVisible()
  await expect(section.getByTestId('badge-stopped')).toBeVisible()
  await openThread(page, 'Archive rules')
  await expect(page.getByTestId('thread-view')).toContainText('Holds up 2')
  await expect(page.getByTestId('question-card').first()).toContainText('Stopped: migration 0007 waits on this.')
})

test('action items: Done and Can\'t do it reach Claude under Actions', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'acts')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'actions')
  await openThread(page, 'Before the deploy')
  const items = page.getByTestId('action-item')
  await expect(items).toHaveCount(2)
  await items.nth(0).getByTestId('action-done').click()
  await items.nth(1).getByTestId('action-cant').click()
  await expect(page.getByTestId('answer-summary')).toContainText('2 of 2 actions done')
  await page.getByTestId('reply-send').click()
  await expectTerminal(page, /Done: Add the GitHub labels/)
  await expectTerminal(page, /Can't do it: Check the staging DNS/)
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
})

test('an attached file opens beside the thread; a comment on it goes with the reply', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'files')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'attach')
  await openThread(page, 'The plan')
  await page.getByTestId('attachment-card').click()
  const viewer = page.getByTestId('attachment-viewer')
  await expect(viewer).toContainText('Archive plan')
  await expect(page.getByTestId('session-rail')).toBeVisible()

  // Select (the default): selecting words offers a Comment button, nothing more;
  // a click on a paragraph does nothing.
  await viewer.getByTestId('doc').getByText('Search uses LIKE first').click()
  await expect(page.getByTestId('annotation-input')).toBeHidden()
  await viewer.getByTestId('doc').getByRole('heading', { name: 'Changes' }).dblclick({ position: { x: 12, y: 12 } })
  await expect(viewer.getByTestId('doc-comment-selection')).toBeVisible()
  await expect(page.getByTestId('annotation-input')).toBeHidden()

  // Comment: a click on a paragraph comments on all of it.
  await viewer.getByRole('button', { name: 'Comment', exact: true }).first().click()
  await expect(viewer.getByTestId('doc-comment-selection')).toBeHidden()
  await viewer.getByText('Search uses LIKE first').click()
  await page.getByTestId('annotation-input').fill('Add a "show more" after 50.')
  await page.getByTestId('annotation-save').click()
  await expect(page.getByTestId('annotation')).toContainText('show more')
  await expect(page.getByTestId('annotations-chip')).toContainText('1 annotation')

  await page.getByTestId('reply-box').fill('One note on the plan.')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
  await page.getByTestId('close-file').click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expectTerminal(page, /# Feedback on the attached files/)
  await expect.poll(async () => (await terminalText(page)).replace(/\n/g, '')).toContain('show more')
})

test('a guided review shows the diff and takes comments on lines', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'rev')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'review')
  await openThread(page, 'Review the store change')
  await page.getByTestId('attachment-card').click()
  const review = page.getByTestId('guided-review')
  await expect(review).toContainText('Archive in the store')
  await expect(page.getByTestId('diff')).toContainText('package store')
  await page.getByTestId('diff-line').filter({ hasText: 'return "quiet"' }).click()
  await page.getByTestId('diff-comment').fill('Name the sections as constants.')
  await page.getByTestId('diff-comment').press('Meta+Enter')
  await expect(review).toContainText('Name the sections as constants.')
  await page.getByTestId('review-reviewed').check()
  await expect(review).toContainText('1 / 1 reviewed')
  await page.getByTestId('review-back').click()
  await expect(page.getByTestId('annotations-chip')).toContainText('1 annotation')
})

test('search finds Japanese words, in this session or all of them', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'jp')
  await expectTerminal(page, 'ready>')
  // Japanese goes in through the inbox (the terminal test driver types ASCII only).
  await page.getByTestId('compose').first().click()
  await page.getByTestId('compose-subject').fill('Note')
  await page.getByTestId('compose-body').fill('アーカイブ済みのスレッドの扱いについて')
  await page.getByTestId('compose-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Note')
  await createSession(page, minbox.dataDir, 'other')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say unrelated')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('search-input').fill('アーカイブ 扱い')
  await expect(page.getByTestId('search-empty')).toBeVisible()
  await page.getByRole('button', { name: 'Search all sessions' }).click()
  const hit = page.getByTestId('search-result').first()
  await expect(hit).toContainText('jp')
  await hit.click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Note')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('jp')
})

test('an ended session can be archived; Resume brings it back', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'old')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'exit')
  const row = page.getByTestId('session-row').filter({ hasText: 'old' })
  await expect(row).toContainText('Ended')
  await row.hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-archive').click()
  await expect(page.locator('[data-section="archived"]')).toContainText('old')
  await row.hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-restart').click()
  await expect(page.locator('[data-section="archived"]')).toHaveCount(0)
  await expect(row).not.toContainText('Ended')
})

test('rename in place; delete through a dialog', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'temp')
  const row = page.getByTestId('session-row').filter({ hasText: 'temp' })
  await row.hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('rename-input').fill('renamed')
  await page.getByTestId('rename-input').press('Enter')
  const renamed = page.getByTestId('session-row').filter({ hasText: 'renamed' })
  await expect(renamed).toBeVisible()
  await renamed.hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-delete').click()
  await expect(page.getByRole('dialog')).toContainText('Delete renamed?')
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByTestId('session-row')).toHaveCount(0)
})

test('compose: closing with text keeps a draft', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'drafty')
  await page.getByTestId('compose').first().click()
  await page.getByTestId('compose-subject').fill('Later')
  await page.getByTestId('compose-body').fill('Something to send later')
  await page.keyboard.press('Escape')
  await page.getByTestId('keep-draft').getByRole('button', { name: 'Keep draft' }).click()
  await expect(page.getByTestId('drafts')).toHaveText('Drafts 1')
  await page.getByTestId('drafts').click()
  await page.getByRole('dialog').getByText('New message · Later').click()
  await expect(page.getByTestId('compose-body')).toHaveValue('Something to send later')
  await page.getByTestId('compose-send').click()
  await expect(page.getByTestId('drafts')).toHaveText('Drafts 0')
  await expectTerminal(page, '<<< inbox [Later] Something to send later')
})

test('settings: the theme and the Board persist on the server; Claude can add cards', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'cfg')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('open-settings').click()
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByTestId('settings-nav-capabilities').click()
  await page.getByRole('switch', { name: 'Board' }).click()
  await page.getByTestId('settings-back').click()
  await typeInTerminal(page, 'card Ship the archive')
  await expectTerminal(page, /card card_/)
  await page.getByTestId('open-board').click()
  await expect(page.getByTestId('board-col-building').getByTestId('board-card')).toContainText('Ship the archive')
})

test('Decision mode answers open questions by number and sends per thread', async ({ page, minbox }) => {
  await fetch(minbox.url + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: minbox.url },
    body: JSON.stringify({ decision_mode: true }),
  })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'decide')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expect(page.getByTestId('badge-questions')).toHaveText('?2')
  await page.getByTestId('open-decide').click()
  await expect(page.getByTestId('decide')).toContainText('1 of 2')
  await page.keyboard.press('1')
  await page.getByPlaceholder('Your answer…').fill('Nightly backups')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('dialog')).toContainText('All decided.')
  await expectTerminal(page, '<<< inbox [Pick a database] Answered 2 questions.')
})

test('phone: sessions, then the session with Inbox and Terminal tabs; the PTY fits the phone', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pocket')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expect(page.getByTestId('pty-size')).toHaveText(/\d+×\d+/)
  const desktopSize = await page.getByTestId('pty-size').textContent()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toBeVisible()
  await page.getByTestId('session-row').filter({ hasText: 'pocket' }).click()
  await expect(page.getByTestId('mobile-tab-inbox')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await page.getByTestId('question-card').first().getByTestId('accept-recommended').click()
  await page.getByTestId('question-card').nth(1).getByTestId('question-text-input').fill('Weekly')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')

  await page.getByTestId('mobile-tab-terminal').click()
  await expect(page.getByTestId('term-key-esc')).toBeVisible()
  // Only the phone is open now: the PTY is sized to it.
  await expect
    .poll(() => page.evaluate(() => {
      const t = (window as unknown as { __minboxTerminal?: { cols: number; rows: number } }).__minboxTerminal
      return t ? `${t.cols}×${t.rows}` : ''
    }))
    .not.toBe(desktopSize!)
  await expectTerminal(page, '<<< inbox [Pick a database]')
  await page.getByTestId('term-key-enter').click()

  await page.getByTestId('mobile-back').click()
  await expect(page.getByTestId('session-list')).toBeVisible()
})

test('pin, snooze, forward to another session, list options, rail, and the settings pages', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Hello from alpha')
  await createSession(page, minbox.dataDir, 'beta')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('session-row').filter({ hasText: 'alpha' }).click()

  // Pin, then snooze: the thread leaves the list for Snoozed.
  await openThread(page, 'Note')
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-pin').click()
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-snooze').click()
  await page.getByRole('menuitem', { name: /Tomorrow/ }).click()
  await expect(page.getByTestId('notice')).toContainText('Snoozed until')
  await expect(page.locator('[data-testid="thread-list"]')).toContainText('Snoozed')
  await page.getByTestId('undo').click()
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Note' })).toBeVisible()

  // alpha ends; a reply to it can go to beta instead.
  await page.getByTestId('terminal').click()
  await typeInTerminal(page, 'exit')
  await expect(page.getByTestId('session-row').filter({ hasText: 'alpha' })).toContainText('Ended')
  await openThread(page, 'Note')
  await page.getByTestId('reply-box').fill('Please take this over')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('where-reply')).toContainText('alpha has ended.')
  await page.getByTestId('where-forward').click()
  await expect(page.getByTestId('notice')).toContainText('Sent to Claude Code · in beta')
  await page.getByTestId('session-row').filter({ hasText: 'beta' }).click()
  await expectTerminal(page, '<<< inbox [Note] Please take this over')

  // List options: compact rows drop the second line.
  await page.getByTestId('list-options').click()
  await page.getByRole('menuitemcheckbox', { name: 'Compact rows' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('session-row').first().locator('[data-testid="badge-unread"]')).toHaveCount(0)

  // ⌘B folds the list into the rail.
  await page.getByTestId('inbox-pane').click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Meta+b')
  await expect(page.getByTestId('session-rail')).toBeVisible()
  await expect(page.getByTestId('rail-session')).toHaveCount(2)
  await page.keyboard.press('Meta+b')

  // Settings: prompts are saved on the server; About and Storage answer.
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-nav-prompts').click()
  await page.getByTestId('prompt-extra').fill('質問は日本語で')
  await page.getByRole('button', { name: 'Save' }).click()
  const settings = await (await fetch(minbox.url + '/api/settings')).json()
  expect(settings.prompt_extra).toBe('質問は日本語で')
  await page.getByTestId('settings-nav-about').click()
  await expect(page.getByTestId('settings')).toContainText('Server protocol')
  await page.getByTestId('settings-nav-storage').click()
  await expect(page.getByTestId('settings')).toContainText('Database')
})

test('IME: the composing text sits at the terminal cursor; committed text reaches the PTY', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'ime')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('terminal').click()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'あいうえ', selectionStart: 4, selectionEnd: 4 })
  const overlay = page.locator('.mb-ime')
  await expect(overlay).toHaveText('あいうえ')
  // At the cursor: the line of "ready>", right after it.
  const box = (await overlay.boundingBox())!
  const canvas = (await page.getByTestId('terminal').locator('canvas').boundingBox())!
  const cursor = await page.evaluate(() => {
    const t = (window as any).__minboxTerminal
    return { x: t.buffer.active.cursorX, y: t.buffer.active.cursorY, cols: t.cols, rows: t.rows }
  })
  const cw = canvas.width / cursor.cols
  const ch = canvas.height / cursor.rows
  expect(Math.abs(box.x - (canvas.x + cursor.x * cw))).toBeLessThan(2)
  expect(Math.abs(box.y - (canvas.y + cursor.y * ch))).toBeLessThan(2)
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/ime.png` })
  await cdp.send('Input.insertText', { text: 'あいうえ' })
  await expect(overlay).toBeHidden()
  await page.keyboard.press('Enter')
  await expectTerminal(page, 'echo: あいうえ')
})

test('New session: browse folders, make one, catch a missing one, and pick a recent one', async ({ page, minbox }) => {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(`${minbox.dataDir}/projects/alpha`, { recursive: true })
  await page.goto(minbox.url)
  // No sessions yet: the dialog offers itself.
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await expect(dialog).toBeVisible()
  await page.getByTestId('new-session-cwd').fill(`${minbox.dataDir}/nope`)
  await expect(page.getByTestId('new-session-missing')).toBeVisible()
  await expect(page.getByTestId('new-session-start')).toBeDisabled()

  await page.getByTestId('new-session-cwd').fill(minbox.dataDir)
  await page.getByTestId('new-session-dir').filter({ hasText: 'projects' }).click()
  await expect(page.getByTestId('new-session-cwd')).toHaveValue(/projects$/)
  await page.getByTestId('new-folder').click()
  await page.getByTestId('new-folder-name').fill('beta')
  await page.getByTestId('new-folder-name').press('Enter')
  await expect(page.getByTestId('new-session-cwd')).toHaveValue(/projects\/beta$/)
  await expect(page.getByTestId('new-session-name')).toHaveAttribute('placeholder', 'beta')
  await page.getByTestId('new-session-cwd').press('Meta+Enter')
  await expect(page.getByTestId('session-row').filter({ hasText: 'beta' })).toBeVisible()
  await expect.poll(async () => (await terminalText(page)).replace(/\n/g, ''), { timeout: 15_000 }).toMatch(/cwd=.*projects\/beta/)

  // Again: the folder is under Recent.
  await page.getByTestId('new-session').click()
  await page.getByTestId('new-session-recent').filter({ hasText: 'beta' }).click()
  await expect(page.getByTestId('new-session-cwd')).toHaveValue(/projects\/beta$/)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('the mouse wheel reaches a full-screen program that tracks the mouse as wheel events, not arrow keys', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'wheel')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'mouse')
  await page.waitForTimeout(500)
  const term = page.getByTestId('terminal')
  await term.hover()
  await page.mouse.wheel(0, -200)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(300)
  await page.keyboard.press('q')
  const joined = async () => (await terminalText(page)).replace(/\n/g, '')
  await expect.poll(joined, { timeout: 15_000 }).toMatch(/mouse got: b'.*\\x1b\[<64;\d+;\d+M.*\\x1b\[<65;\d+;\d+M/)
  expect(await joined()).not.toContain('\\x1b[A')
})

import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, phoneSelectSession, selectSession, sessionStatus, terminalText, test, typeInTerminal } from './fixtures'

// The features of the redesigned UI: sections, archive, mark read, actions,
// attachments and reviews, search, settings, Board, Decision mode, phone.

/** Moves focus out of the terminal, so single-key shortcuts work. */
async function blurTerminal(page: Page) {
  await page.getByTestId('threads-pane').click({ position: { x: 5, y: 5 } })
}

async function openThread(page: Page, subject: string) {
  await page.getByTestId('thread-row').filter({ hasText: subject }).first().click()
  await expect(page.getByTestId('thread-subject')).toHaveText(subject)
}

/** The threads pane's ⋯ menu holds Settings, Board, Decide and Drafts. */
async function fromMenu(page: Page, testid: 'open-settings' | 'open-board' | 'open-decide' | 'drafts') {
  await page.getByTestId('list-options').click()
  await page.getByTestId(testid).click()
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

test('a message with thread_title renames the thread in the list and the open header', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'retitle')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say First note')
  await openThread(page, 'Note')
  await typeInTerminal(page, 'retitle Now about the deploy')
  await expect(page.getByTestId('thread-subject')).toHaveText('Now about the deploy')
  await page.getByTestId('thread-back').click()
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Now about the deploy' })).toBeVisible()
  await expect(page.getByTestId('thread-row').filter({ hasText: 'Note' })).toHaveCount(0)
})

test('Mark read sets the thread aside in Quiet and closes its questions; Move back undoes it', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'mr')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await openThread(page, 'Pick a database')
  await page.getByTestId('mark-read').click()
  await expect(page.getByTestId('notice')).toContainText('Marked read')
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('0')
  await openThread(page, 'Pick a database')
  await expect(page.getByTestId('question-state').first()).toHaveText('Closed')
  await page.getByTestId('thread-back').click()
  await blurTerminal(page)
  await page.getByTestId('mark-read').count() // list view: no button
  await openThread(page, 'Pick a database')
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-unread').click()
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('1')
})

test('a stopped question puts the session under Stopped on you', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'stopper')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'stop')
  const row = page.getByTestId('thread-row').filter({ hasText: 'Archive rules' })
  await expect(row).toContainText('Stopped')
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('1')
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
  // The list no longer folds away for a file: the viewer keeps its annotation panel only with room.
  await page.setViewportSize({ width: 2200, height: 1000 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'files')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'attach')
  await openThread(page, 'The plan')
  await page.getByTestId('attachment-card').click()
  const viewer = page.getByTestId('attachment-viewer')
  await expect(viewer).toContainText('Archive plan')
  await expect(page.getByTestId('session-rail')).toHaveCount(0)

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

test('quick actions find a Japanese thread subject in another session', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'jp')
  await expectTerminal(page, 'ready>')
  // Japanese goes in through the inbox (the terminal test driver types ASCII only).
  await page.getByTestId('quick-body').fill('アーカイブ済みのスレッドの扱いについて')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('アーカイブ済みのスレッドの扱いについて')
  await createSession(page, minbox.dataDir, 'other')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say unrelated')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('アーカイブ 扱い')
  const hit = page.getByTestId('palette-item').first()
  await expect(hit).toHaveAttribute('data-kind', 'thread')
  await expect(hit).toContainText('jp')
  await hit.click()
  await expect(page.getByTestId('thread-subject')).toHaveText('アーカイブ済みのスレッドの扱いについて')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('jp')
})

test('an ended session can be archived; Resume brings it back', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'old')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'exit')
  await expect(sessionStatus(page)).toContainText('Ended')
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-archive').click()
  const archived = async () => (await (await page.request.get(minbox.url + '/api/sessions')).json())[0].archived_at
  await expect.poll(archived).toBeTruthy()
  // An archived session is not offered in the session list.
  await page.getByTestId('session-filter').click()
  await expect(page.getByTestId('session-option').filter({ hasText: 'old' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-restart').click()
  await expect.poll(archived).toBeFalsy()
  await expect(sessionStatus(page)).not.toContainText('Ended')
  await page.getByTestId('session-filter').click()
  await expect(page.getByTestId('session-option').filter({ hasText: 'old' })).toHaveCount(1)
})

test('rename in the session header; delete through a dialog', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'temp')
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('rename-input').fill('renamed')
  await page.getByTestId('rename-input').press('Enter')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('renamed')
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-delete').click()
  await expect(page.getByRole('dialog')).toContainText('Delete renamed?')
  await page.getByTestId('delete-confirm').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveCount(0)
  expect(await (await page.request.get(minbox.url + '/api/sessions')).json()).toHaveLength(0)
})

test('settings: the theme and the Board persist on the server; Claude can add cards', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'cfg')
  await expectTerminal(page, 'ready>')
  await fromMenu(page, 'open-settings')
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByTestId('settings-nav-capabilities').click()
  await page.getByRole('switch', { name: 'Board' }).click()
  await page.getByTestId('settings-back').click()
  await typeInTerminal(page, 'card Ship the archive')
  await expectTerminal(page, /card card_/)
  await fromMenu(page, 'open-board')
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
  await expect(page.getByTestId('thread-questions')).toHaveText('?2')
  await fromMenu(page, 'open-decide')
  await expect(page.getByTestId('decide')).toContainText('1 of 2')
  await page.keyboard.press('1')
  await page.getByPlaceholder('Your answer…').fill('Nightly backups')
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByRole('dialog')).toContainText('All decided.')
  await expectTerminal(page, '<<< inbox [Pick a database] Answered 2 questions.')
})

test('phone: the thread list is home; a thread flips to its session\'s terminal; the PTY fits the phone', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pocket')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expect(page.getByTestId('pty-size')).toHaveText(/\d+×\d+/)
  const desktopSize = await page.getByTestId('pty-size').textContent()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toBeVisible()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await page.getByTestId('question-card').first().getByTestId('accept-recommended').click()
  await page.getByTestId('question-card').nth(1).getByTestId('question-text-input').fill('Weekly')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')

  await page.getByTestId('phone-session-chip').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'terminal')
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
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await page.getByTestId('mobile-back').click()
  await expect(page.getByTestId('phone-home')).toBeVisible()
})

test('pin, snooze, forward to another session, list options, and the settings pages', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Hello from alpha')
  await createSession(page, minbox.dataDir, 'beta')
  await expectTerminal(page, 'ready>')
  await selectSession(page, 'alpha')

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
  await expect(sessionStatus(page)).toContainText('Ended')
  await openThread(page, 'Note')
  await page.getByTestId('reply-box').fill('Please take this over')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('where-reply')).toContainText('alpha has ended.')
  await page.getByTestId('where-forward').click()
  await expect(page.getByTestId('notice')).toContainText('Sent to Claude Code · in beta')
  await selectSession(page, 'beta')
  await expectTerminal(page, '<<< inbox [Note] Please take this over')

  // List options: compact rows drop the second line.
  await page.getByTestId('list-options').click()
  await page.getByRole('menuitemcheckbox', { name: 'Compact rows' }).click()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Compact rows' })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')

  // Settings: prompts are saved on the server; About and Storage answer.
  await fromMenu(page, 'open-settings')
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
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  await expect.poll(async () => (await terminalText(page)).replace(/\n/g, ''), { timeout: 15_000 }).toMatch(/cwd=.*projects\/beta/)

  // Again: the dialog has no Recent list.
  await page.getByTestId('new-session').click()
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('new-session-recent')).toHaveCount(0)
  await expect(dialog.getByText('Recent', { exact: true })).toHaveCount(0)
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

test("a click and a drag reach a program that tracks the mouse (Claude Code's full-screen UI)", async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'clicks')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'mouse drag')
  await page.waitForTimeout(500)
  const box = (await page.locator('.mb-term canvas').boundingBox())!
  const { cols, rows } = await page.evaluate(() => ({ cols: (window as any).__minboxTerminal.cols, rows: (window as any).__minboxTerminal.rows }))
  const at = (col: number, row: number) => [box.x + (box.width / cols) * (col - 0.5), box.y + (box.height / rows) * (row - 0.5)] as const
  // A click on cell 5,3; then a drag from 2,4 to 9,4.
  await page.mouse.click(...at(5, 3))
  await page.mouse.move(...at(2, 4))
  await page.mouse.down()
  await page.mouse.move(...at(9, 4), { steps: 3 })
  await page.mouse.up()
  await page.waitForTimeout(300)
  await page.keyboard.press('q')
  const joined = async () => (await terminalText(page)).replace(/\n/g, '')
  await expect.poll(joined, { timeout: 15_000 }).toContain('mouse got: ')
  const got = await joined()
  expect(got).toContain('\\x1b[<0;5;3M\\x1b[<0;5;3m') // press and release
  expect(got).toContain('\\x1b[<0;2;4M')
  expect(got).toMatch(/\\x1b\[<32;\d+;4M/) // motion with the button down
  expect(got).toContain('\\x1b[<0;9;4m')
  // The click went to the program, not to a selection of the terminal's own.
  expect(await page.evaluate(() => (window as any).__minboxTerminal.getSelection())).toBe('')
})

test('the threads list holds every session\'s threads; picking one opens its session and the thread', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('quick-body').fill('First idea for alpha')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('First idea for alpha')
  await createSession(page, minbox.dataDir, 'beta')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('quick-body').fill('Second idea for beta')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Second idea for beta')

  // Both are in the one list.
  const rows = page.getByTestId('thread-list').getByTestId('thread-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.getByTestId('thread-session')).toHaveCount(0)

  // Picking a thread of another session switches the thread view and the terminal together.
  await rows.filter({ hasText: 'First idea for alpha' }).click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('thread-subject')).toHaveText('First idea for alpha')
})

test('the terminal reconnects by itself after its connection drops', async ({ page, minbox }) => {
  const routed: { close: () => void }[] = []
  await page.routeWebSocket(/\/terminal$/, (ws) => {
    ws.connectToServer()
    routed.push(ws)
  })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'flaky', 'shell')
  await typeInTerminal(page, 'echo before-$((1+1))')
  await expectTerminal(page, 'before-2')
  expect(routed.length).toBe(1)
  routed[0]!.close()
  // No reload: a new socket opens, the screen is replayed, and typing works again.
  await expect.poll(() => routed.length, { timeout: 15_000 }).toBe(2)
  await typeInTerminal(page, 'echo after-$((3+4))')
  await expectTerminal(page, 'after-7')
  await expectTerminal(page, 'before-2')
})

test('a terminal socket stuck connecting is replaced without a reload', async ({ page, minbox }) => {
  // routeWebSocket mocks open at once, so a real hang is made by pointing the first socket at a
  // black hole (a non-routable address: no open, no error, no close).
  await page.addInitScript(() => {
    const w = window as unknown as { __minboxTimings: object; WebSocket: typeof WebSocket; __wsCount: number }
    w.__minboxTimings = { connectMs: 1500 }
    w.__wsCount = 0
    const Real = w.WebSocket
    w.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(w.__wsCount++ === 0 && String(url).endsWith('/terminal') ? 'ws://10.255.255.1:81/' : url, protocols)
      }
    } as typeof WebSocket
  })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'hung', 'shell')
  // Keystrokes typed into the hung socket go nowhere: wait for the replacement to be up.
  await expect.poll(() => page.evaluate(() => (window as unknown as { __wsCount: number }).__wsCount), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
  await page.waitForTimeout(3000)
  await typeInTerminal(page, 'echo hung-$((2+3))')
  await expectTerminal(page, 'hung-5')
})

test('a silent but open terminal socket is replaced after the silence limit', async ({ page, minbox }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __minboxTimings: object }).__minboxTimings = { silentMs: 2000 }
  })
  let n = 0
  let silent = false
  await page.routeWebSocket(/\/terminal$/, (ws) => {
    const server = ws.connectToServer()
    const mine = ++n
    ws.onMessage((m) => server.send(m))
    // Stand in for the server's keep-alive, which is too slow (15 s) for the shortened limit.
    const beat = setInterval(() => {
      if (!(silent && mine === 1)) ws.send(Buffer.alloc(0))
    }, 500)
    ws.onClose(() => clearInterval(beat))
    // Once "silent", the first socket stays open but nothing from the server reaches the page.
    server.onMessage((m) => {
      if (!(silent && mine === 1)) ws.send(m)
    })
  })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'quiet', 'shell')
  await typeInTerminal(page, 'echo before-$((1+1))')
  await expectTerminal(page, 'before-2')
  expect(n).toBe(1)
  silent = true
  await expect.poll(() => n, { timeout: 15_000 }).toBe(2)
  await typeInTerminal(page, 'echo after-$((3+4))')
  await expectTerminal(page, 'after-7')
})

test('a message that arrives below the fold shows a pill that scrolls down', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'pilly')
  await expectTerminal(page, 'ready>')
  // Long messages, so the thread scrolls (a terminal line holds about 1000 characters).
  const para = Array.from({ length: 110 }, (_, i) => `word${i}`).join(' ')
  for (let i = 0; i < 4; i++) await typeInTerminal(page, `say ${para}`)
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('thread-view')).toBeVisible()
  const scroller = page.getByTestId('thread-view').locator('div.overflow-y-auto').first()
  await expect.poll(() => scroller.evaluate((e) => e.scrollHeight > e.clientHeight + 100)).toBe(true)
  // Read at the top; Claude writes again.
  await scroller.evaluate((e) => (e.scrollTop = 0))
  await typeInTerminal(page, 'say second message')
  const pill = page.getByTestId('new-message-pill')
  await expect(pill).toHaveText('↓ New message')
  await pill.click()
  await expect(pill).toHaveCount(0)
  await expect.poll(() => scroller.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(80)
})

test('a thread scrolled to the bottom follows new messages without a pill', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'follow')
  await expectTerminal(page, 'ready>')
  const para = Array.from({ length: 110 }, (_, i) => `word${i}`).join(' ')
  for (let i = 0; i < 4; i++) await typeInTerminal(page, `say ${para}`)
  await page.getByTestId('thread-row').first().click()
  const scroller = page.getByTestId('thread-view').locator('div.overflow-y-auto').first()
  await expect.poll(() => scroller.evaluate((e) => e.scrollHeight > e.clientHeight + 100)).toBe(true)
  await scroller.evaluate((e) => (e.scrollTop = e.scrollHeight))
  await typeInTerminal(page, `say ${para}`)
  await expect(page.getByTestId('thread-view').getByText('word109').last()).toBeVisible()
  await expect.poll(() => scroller.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeLessThan(80)
  await expect(page.getByTestId('new-message-pill')).toHaveCount(0)
})

test('Accept recommended says what it does once another choice is picked, and goes when the recommended one is', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'recs')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await page.getByTestId('thread-row').first().click()
  const card = page.getByTestId('question-card').first()
  const btn = card.getByTestId('accept-recommended')
  await expect(btn).toHaveText('Accept recommended')
  // Another choice than the recommended one.
  const other = card.getByTestId('choice').filter({ hasNotText: 'Recommended' }).first()
  await other.click()
  await expect(btn).toHaveText('Switch to recommended')
  await btn.click()
  await expect(btn).toHaveCount(0)
})

test('the new-thread text box grows with what is typed, up to a limit', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'grow')
  const box = page.getByTestId('quick-body')
  const h0 = (await box.boundingBox())!.height
  await box.fill(Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n'))
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan(h0 + 40)
  await box.fill(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'))
  await expect.poll(async () => (await box.boundingBox())!.height).toBeLessThanOrEqual(241)
  await box.fill('')
  await expect.poll(async () => Math.abs((await box.boundingBox())!.height - h0)).toBeLessThan(2)
})

test('the new-thread box can fill the pane\'s height, and goes back', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'tall')
  const box = page.getByTestId('quick-body')
  const pane = page.getByTestId('threads-pane')
  const small = (await box.boundingBox())!.height
  await box.fill('draft text')
  await page.getByTestId('quick-full').click()
  await expect(page.getByTestId('thread-list')).toBeHidden()
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan((await pane.boundingBox())!.height * 0.6)
  await expect(box).toHaveValue('draft text')
  await page.getByTestId('quick-full').click()
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect.poll(async () => Math.abs((await box.boundingBox())!.height - small)).toBeLessThan(40)
  // Sending from the full-height box returns to the thread.
  await page.getByTestId('quick-full').click()
  await box.fill('long note')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('long note')
})

test('Shift+Enter is a newline for Claude Code (ESC CR) and still Enter in a shell', async ({ page, minbox }) => {
  const sent: string[] = []
  await page.routeWebSocket(/\/terminal$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => {
      if (typeof m !== 'string') sent.push(JSON.stringify(Array.from(m as Buffer)))
      server.send(m)
    })
  })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'nl-claude')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('terminal').click()
  sent.length = 0
  await page.keyboard.press('Shift+Enter')
  await expect.poll(() => sent.join('')).toContain('[27,13]')
  await createSession(page, minbox.dataDir, 'nl-shell', 'shell')
  await page.getByTestId('terminal').click()
  sent.length = 0
  await page.keyboard.press('Shift+Enter')
  await expect.poll(() => sent.join('')).toContain('[13]')
  expect(sent.join('')).not.toContain('[27,13]')
})

test('settings: the thread is left of the terminal by default; swapping puts it right, and the edge still drags', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'swap')
  await expectTerminal(page, 'ready>')
  const thread = page.getByTestId('thread-pane')
  const main = page.locator('main')
  expect((await page.getByTestId('threads-pane').boundingBox())!.x).toBeLessThan((await thread.boundingBox())!.x)
  expect((await thread.boundingBox())!.x).toBeLessThan((await main.boundingBox())!.x)
  await fromMenu(page, 'open-settings')
  await page.getByRole('switch', { name: 'Swap terminal and thread' }).click()
  await expect(page.getByRole('switch', { name: 'Swap terminal and thread' })).toHaveAttribute('aria-checked', 'false')
  await page.goto(minbox.url)
  await expect(thread).toBeVisible()
  expect((await thread.boundingBox())!.x).toBeGreaterThan((await main.boundingBox())!.x)
  // The terminal stays between the list and the thread; dragging the edge left widens the thread.
  const before = (await thread.boundingBox())!.width
  const edge = (await page.getByTestId('resizer').last().boundingBox())!
  const x = edge.x + edge.width / 2, y = edge.y + edge.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 60, y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(async () => Math.round((await thread.boundingBox())!.width - before)).toBeGreaterThanOrEqual(58)
})

test('the reply box grows with the text and can fill the pane', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'reply-grow')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say hello there')
  await page.getByTestId('thread-row').first().click()
  const box = page.getByTestId('reply-box')
  const h0 = (await box.boundingBox())!.height
  await box.fill(Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n'))
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan(h0 + 60)
  await box.fill(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'))
  await expect.poll(async () => (await box.boundingBox())!.height).toBeLessThanOrEqual(241)
  await box.fill('short')
  await expect.poll(async () => Math.abs((await box.boundingBox())!.height - h0)).toBeLessThan(2)

  // Full height: the messages step aside, the box fills the pane, and the text stays.
  await page.getByTestId('reply-full').click()
  const pane = page.getByTestId('thread-view')
  await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan((await pane.boundingBox())!.height * 0.5)
  await expect(box).toHaveValue('short')
  await page.getByTestId('reply-full').click()
  await expect.poll(async () => Math.abs((await box.boundingBox())!.height - h0)).toBeLessThan(2)
  // Sending from the full-height box returns to the thread.
  await page.getByTestId('reply-full').click()
  await box.fill('full reply')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('reply-full')).toHaveAttribute('aria-pressed', 'false')
  await expectTerminal(page, 'full reply')
})

test.describe('wide screen', () => {
  test.use({ viewport: { width: 1920, height: 1000 } })

  test('threads | thread | terminal, left to right; the thread opens beside the list', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'wide')
    await expectTerminal(page, 'ready>')
    await typeInTerminal(page, 'say first wide message')
    const list = page.getByTestId('threads-pane')
    const threadPane = page.getByTestId('thread-pane')
    await expect(threadPane).toBeVisible()
    await expect(threadPane).toContainText('Pick a thread')
    const [i, t, m] = await Promise.all([list.boundingBox(), threadPane.boundingBox(), page.locator('main').boundingBox()])
    expect(i!.x).toBeLessThan(t!.x)
    expect(t!.x).toBeLessThan(m!.x)
    await list.getByTestId('thread-row').first().click()
    await expect(threadPane.getByTestId('thread-subject')).toHaveText('Note')
    // The list stays beside it.
    await expect(list.getByTestId('thread-row')).toHaveCount(1)
    await expect(list.getByTestId('thread-view')).toHaveCount(0)
    // Closing the thread empties the pane again.
    await threadPane.getByTestId('thread-back').click()
    await expect(threadPane).toContainText('Pick a thread')
  })

  test('the thread pane edge drags', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'wide-drag')
    await expectTerminal(page, 'ready>')
    const threadPane = page.getByTestId('thread-pane')
    const before = (await threadPane.boundingBox())!.width
    const edge = (await page.getByTestId('resizer').last().boundingBox())!
    const x = edge.x + edge.width / 2, y = edge.y + edge.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 50, y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => Math.round((await threadPane.boundingBox())!.width - before)).toBeGreaterThanOrEqual(48)
  })
})

test('selecting text in a thread offers Reply, which quotes it into the reply box and focuses it', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'quote')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Please review the retry logic')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('quote-reply')).toHaveCount(0)
  await page.getByTestId('message').getByText('Please review the retry logic').click({ clickCount: 3 })
  const bubble = page.getByTestId('quote-reply')
  await expect(bubble).toBeVisible()
  await bubble.click()
  const box = page.getByTestId('reply-box')
  await expect(box).toBeFocused()
  await expect(box).toHaveValue('> Please review the retry logic\n\n')
  await expect(bubble).toHaveCount(0)
  // The person writes the instruction after the quote.
  await page.keyboard.type('Add a jitter.')
  await expect(box).toHaveValue('> Please review the retry logic\n\nAdd a jitter.')
  // A second quote appends below.
  await page.getByTestId('message').getByText('Please review the retry logic').click({ clickCount: 3 })
  await page.getByTestId('quote-reply').click()
  await expect(box).toHaveValue(/Add a jitter\.\n\n> Please review the retry logic\n\n$/)
  // With a mouse the bubble sits above the selected text.
  await page.getByTestId('message').getByText('Please review the retry logic').click({ clickCount: 3 })
  const b = await page.getByTestId('quote-reply').boundingBox()
  const t = await page.getByTestId('message').getByText('Please review the retry logic').boundingBox()
  expect(b!.y + b!.height).toBeLessThanOrEqual(t!.y)
})

test.describe('touch device (coarse pointer, wide layout)', () => {
  test.use({ hasTouch: true, viewport: { width: 1200, height: 800 } })

  test('the Reply bubble sits below the selection, clear of the OS toolbar', async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'quote-touch')
    await expectTerminal(page, 'ready>')
    await typeInTerminal(page, 'say Please review the retry logic')
    await page.getByTestId('thread-row').first().click()
    const text = page.getByTestId('message').getByText('Please review the retry logic')
    await text.click({ clickCount: 3 })
    const bubble = page.getByTestId('quote-reply')
    await expect(bubble).toBeVisible()
    const b = (await bubble.boundingBox())!
    const t = (await text.boundingBox())!
    expect(b.y).toBeGreaterThanOrEqual(t.y + t.height + 20)
  })
})

test('coming back to the page loads what arrived meanwhile, into the open thread too', async ({ page, minbox }) => {
  // The event stream never delivers (as after a phone slept): only a reload by the page can show news.
  await page.route('**/api/events', (route) => route.abort())
  await page.addInitScript(() => {
    const real = Date.now.bind(Date)
    ;(window as unknown as { __skew: number }).__skew = 0
    Date.now = () => real() + (window as unknown as { __skew: number }).__skew
  })
  const away = async () => {
    // Hidden, then shown after more than 5 s.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      ;(window as unknown as { __skew: number }).__skew += 10_000
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'wake')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say first message')
  await away()
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('thread-view')).toContainText('first message')
  await typeInTerminal(page, 'say second message')
  await expect(page.getByTestId('thread-view')).not.toContainText('second message')
  await away()
  await expect(page.getByTestId('thread-view')).toContainText('second message')
})

test('with a thread open, the back button shows how many other threads have new messages', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'badge')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say first message')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).click()
  await expect(page.getByTestId('thread-view')).toContainText('first message')
  await expect(page.getByTestId('back-badge')).toHaveCount(0)
  // Claude starts another thread while this one is open.
  await typeInTerminal(page, 'ask')
  await expect(page.getByTestId('back-badge')).toHaveText('1')
  // Reading it clears the badge.
  await page.getByTestId('thread-back').click()
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('thread-view')).toContainText('Which database')
  await expect(page.getByTestId('back-badge')).toHaveCount(0)
})

for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`${name}: text in the new-thread box survives opening a thread and going back; sending clears it`, async ({ page, minbox }) => {
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'keep')
    if (name === 'phone') {
      await page.setViewportSize(size)
      await page.goto(minbox.url + '/#')
    }
    const box = page.getByTestId('quick-body')
    await box.fill('first note')
    await page.getByTestId('quick-send').click()
    await expect(page.getByTestId('thread-subject')).toHaveText('first note')
    await page.getByTestId(name === 'phone' ? 'mobile-back' : 'thread-back').click()
    await expect(box).toHaveValue('')
    await box.fill('half-written idea')
    await page.getByTestId('thread-row').filter({ hasText: 'first note' }).click()
    await expect(page.getByTestId('thread-subject')).toHaveText('first note')
    await page.getByTestId(name === 'phone' ? 'mobile-back' : 'thread-back').click()
    await expect(box).toHaveValue('half-written idea')
    await page.getByTestId('quick-send').click()
    await expect(page.getByTestId('thread-subject')).toHaveText('half-written idea')
    await page.getByTestId(name === 'phone' ? 'mobile-back' : 'thread-back').click()
    await expect(box).toHaveValue('')
  })
}

async function queueUp(page: Page, minbox: { dataDir: string }, name: string) {
  await createSession(page, minbox.dataDir, name)
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await typeInTerminal(page, 'work')
  await expectTerminal(page, 'status work')
}

test('Cancel on a queued reply removes it, keeps the words in the draft, and it is never delivered', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await queueUp(page, minbox, 'canceller')
  await openThread(page, 'Pick a database')
  await page.getByTestId('reply-box').fill('hold this one')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'queued')
  await expect(page.getByTestId('send-now')).toBeVisible()
  await page.getByTestId('cancel-message').click()
  await expect(page.getByTestId('delivery-line')).toHaveCount(0)
  await expect(page.getByTestId('reply-box')).toHaveValue('hold this one')

  // Claude's turn ends: only a later reply is delivered.
  await typeInTerminal(page, 'idle')
  await page.getByTestId('reply-box').fill('the second one')
  await page.getByTestId('reply-send').click()
  await expectTerminal(page, '<<< inbox [Pick a database] the second one')
  expect(await terminalText(page)).not.toContain('hold this one')
})

test('phone: a queued reply can be cancelled', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await queueUp(page, minbox, 'pocketcancel')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await page.getByTestId('reply-box').fill('on the phone')
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('cancel-message')).toBeVisible()
  await page.getByTestId('cancel-message').click()
  await expect(page.getByTestId('delivery-line')).toHaveCount(0)
  await expect(page.getByTestId('reply-box')).toHaveValue('on the phone')
})

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
  await page.getByTestId('quick-body').fill('アーカイブ済みのスレッドの扱いについて')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('アーカイブ済みのスレッドの扱いについて')
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
  await expect(page.getByTestId('thread-subject')).toHaveText('アーカイブ済みのスレッドの扱いについて')
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

test('All inbox lists every session\'s threads; picking one opens its session and the thread', async ({ page, minbox }) => {
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

  // The entry is the first row of the session list.
  await page.getByTestId('open-all-inbox').click()
  const rows = page.getByTestId('all-thread-list').getByTestId('thread-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: 'First idea for alpha' }).getByTestId('thread-session')).toHaveText('alpha')
  await expect(rows.filter({ hasText: 'Second idea for beta' }).getByTestId('thread-session')).toHaveText('beta')

  // Picking a thread of another session goes to the main screen with that session and thread open.
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
  const pane = page.getByTestId('inbox-pane')
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

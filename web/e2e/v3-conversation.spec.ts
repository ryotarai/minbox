// The conversation of an agent stream and a task (as the thread view before v3): the reply box (draft,
// growth, full height, long paste, drop, phone), message actions (context menu, copy, 👍, start a new
// thread, mark unread), delivery (into a running turn, cancel, resume, forward), new / pill / older messages,
// fold all, files (artifacts, O, ] [, comments), Q, picked answers with the words, the conversation's
// menu (snooze), Linear.
import { test, expect, expectTerminal, typeInTerminal, type Minbox } from './fixtures'
import type { Page } from '@playwright/test'
import { agentReply, api, say, startAgent, taskNamed, type Agent } from './v3'

async function open(page: Page, m: Minbox, a: Agent) {
  await page.goto(`${m.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('composer-text')).toBeVisible()
}

const box = (page: Page) => page.getByTestId('composer-text')
const userMsgs = (page: Page) => page.locator('[data-testid="v3-message"][data-author="user"]')
const stream = (m: Minbox, a: Agent) => api(m, 'GET', `/api/v3/sessions/${a.id}/stream`)

test('reply box: the draft survives navigation and reload; it grows; full height and back', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await open(page, minbox, a)
  const h0 = (await box(page).boundingBox())!.height
  await box(page).fill('line 1\nline 2\nline 3\nline 4\nline 5\nline 6')
  await expect.poll(async () => (await box(page).boundingBox())!.height).toBeGreaterThan(h0 + 40)
  await expect(page.getByTestId('draft-saved')).toBeVisible()
  await page.getByTestId('nav-board').click()
  await expect(page.getByTestId('board')).toBeVisible()
  await page.goBack()
  await expect(box(page)).toHaveValue(/line 6$/)
  await page.reload()
  await expect(box(page)).toHaveValue(/line 6$/)
  // Full height: the messages give way to the box; back again.
  await page.getByTestId('reply-full').click()
  await expect(page.getByTestId('stream-view').locator('.v-scroll')).toBeHidden()
  expect((await box(page).boundingBox())!.height).toBeGreaterThan(400)
  await page.getByTestId('reply-full').click()
  await expect(page.getByTestId('stream-view').locator('.v-scroll')).toBeVisible()
  // Esc leaves the box; R comes back to it.
  await box(page).focus()
  await page.keyboard.press('Escape')
  await expect(box(page)).not.toBeFocused()
})

test('reply box: a long paste becomes a file (Put back undoes it); a dropped file attaches; a tile is removed', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await open(page, minbox, a)
  const long = 'x'.repeat(40 * 1024)
  await box(page).evaluate((el, text) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, long)
  const tile = page.getByTestId('compose-file')
  await expect(tile).toHaveCount(1)
  await expect(tile).toHaveAttribute('data-state', 'done')
  await expect(box(page)).toHaveValue('')
  await tile.getByTestId('put-back').click()
  await expect(tile).toHaveCount(0)
  await expect(box(page)).toHaveValue(long)
  await box(page).fill('')
  // Drop a file onto the reply box.
  await page.getByTestId('composer').evaluate((el) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['dropped text'], 'dropped.txt', { type: 'text/plain' }))
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await expect(tile).toHaveCount(1)
  await expect(tile).toContainText('dropped.txt')
  await tile.getByRole('button', { name: /Remove/ }).click()
  await expect(tile).toHaveCount(0)
})

test('message actions: right-click Reply and Copy; ⋯ starts a new thread from a message (a marker stays); 👍 sends Looks good', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'is the staging server up?')
  const r = await agentReply(minbox, a, /Sure — noted/)
  await open(page, minbox, a)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${r.id}"]`)
  await msg.locator('.v-bd').click({ button: 'right' })
  const menu = page.getByTestId('message-context-menu')
  await expect(menu).toBeVisible()
  await menu.getByTestId('message-copy').click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Sure — noted.')
  await msg.locator('.v-bd').click({ button: 'right' })
  await page.getByTestId('message-reply').click()
  await expect(box(page)).toBeFocused()

  // ⋯ → Start new thread from here: the fork dialog, into the same agent; the message gets a marker.
  await msg.getByTestId('msg-menu').click()
  await page.getByTestId('message-fork-item').click()
  await expect(page.getByTestId('fork-dialog')).toBeVisible()
  await page.getByTestId('fork-title').fill('Staging follow-up')
  await page.getByTestId('fork-start').click()
  await expect(page.getByTestId('fork-dialog')).toHaveCount(0)
  await open(page, minbox, a)
  await expect(page.getByTestId('fork-marker')).toContainText('Staging follow-up')

  // 👍: "Looks good" after 5 s (Undo meanwhile).
  await msg.getByTestId('thumbs-up').click()
  await expect.poll(async () => (await stream(minbox, a)).messages.some((m: any) => m.words === '👍 Looks good'), { timeout: 12_000 }).toBe(true)
})

test('delivery: a busy agent gets messages in its running turn, in order; a queued one can be cancelled', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await open(page, minbox, a)
  await typeInTerminal(page, 'work')
  await expectTerminal(page, 'status work')
  // The agent's stream has no "is working" line: a running turn says nothing useful (tasks show their own).
  await expect(page.getByTestId('stream-view').getByTestId('working-line')).toHaveCount(0)
  // Working: the message goes into the running turn at once (as Send now did); no Queued line, no Send now.
  await box(page).fill('mid-turn one')
  await page.getByTestId('composer-send').click()
  await box(page).fill('mid-turn two')
  await page.getByTestId('composer-send').click()
  // Delivery belongs to the person's bubble: its header says sending → ✓ delivered (the latest message only),
  // and no separate line repeats it.
  const line = page.getByTestId('delivery-line')
  const lastStatus = userMsgs(page).last().getByTestId('delivery')
  await expect(lastStatus).toHaveAttribute('data-delivery', 'delivered', { timeout: 15_000 })
  await expect(lastStatus).toHaveText('delivered')
  await expect(lastStatus).toHaveAttribute('title', /Delivered to api, /)
  await expect(page.getByTestId('delivery')).toHaveCount(1)
  await expect(line).toHaveCount(0)
  await expectTerminal(page, /mid-turn one[\s\S]*mid-turn two/)
  await expect(page.getByTestId('send-now')).toHaveCount(0)
  await expect(page.getByText(/Queued|turn ends/)).toHaveCount(0)
  // The integration does not take it (not polling): the header says sending; after a moment a small line under
  // the bubble, right-aligned with it, says it is waiting and offers Cancel; its words come back.
  await typeInTerminal(page, 'deaf')
  await expectTerminal(page, 'status deaf')
  await box(page).fill('first try')
  await page.getByTestId('composer-send').click()
  await expect(userMsgs(page).last().getByTestId('delivery')).toHaveText('sending')
  await expect(line).toHaveAttribute('data-delivery', 'queued')
  await expect(line).toContainText('Waiting for Claude Code…')
  await expect(line).not.toContainText('Sending')
  const bubble = await userMsgs(page).last().boundingBox()
  const lineBox = await line.boundingBox()
  expect(Math.abs(bubble!.x + bubble!.width - (lineBox!.x + lineBox!.width))).toBeLessThan(2) // its right edge is the bubble's
  expect(lineBox!.y).toBeGreaterThanOrEqual(bubble!.y + bubble!.height - 1) // under it
  expect(lineBox!.y).toBeLessThan(bubble!.y + bubble!.height + 12) // right under it
  await expect(line.getByTestId('send-now')).toHaveCount(0)
  await line.getByTestId('cancel-message').click()
  await expect(box(page)).toHaveValue('first try')
  await expect(userMsgs(page).filter({ hasText: 'first try' })).toHaveCount(0)
  await page.getByTestId('composer-send').click()
  await expect(line).toHaveAttribute('data-delivery', 'queued')
  await typeInTerminal(page, 'listen')
  await expect(userMsgs(page).last().getByTestId('delivery')).toHaveAttribute('data-delivery', 'delivered', { timeout: 25_000 })
  await expect(line).toHaveCount(0)
})

test('an ended agent: Send asks where the reply goes; Resume delivers it, or it goes to another agent', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  await api(minbox, 'POST', `/api/sessions/${a.id}/stop`)
  await expect.poll(async () => (await api(minbox, 'GET', '/api/sessions')).find((x: any) => x.id === a.id)?.status, { timeout: 15_000 }).toBe('ended')
  await open(page, minbox, a)
  await box(page).fill('for the other agent')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('where-reply')).toBeVisible()
  await page.getByTestId('where-forward').filter({ hasText: 'web' }).click()
  await expect.poll(async () => (await stream(minbox, b)).messages.some((m: any) => /for the other agent/.test(m.words ?? m.body)), { timeout: 15_000 }).toBe(true)
  await box(page).fill('please carry on')
  await page.getByTestId('composer-send').click()
  await page.getByTestId('where-resume').click()
  await expect(userMsgs(page).last().getByTestId('delivery')).toHaveAttribute('data-delivery', 'delivered', { timeout: 30_000 })
})

test('new since you looked: a divider, N jumps to it; mark unread from a message', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'is the staging server up?')
  const r = await agentReply(minbox, a, /Sure — noted/)
  await open(page, minbox, a)
  const divider = page.getByTestId('new-divider')
  await expect(divider).toBeVisible()
  // The divider sits right above the reply.
  const next = divider.locator('xpath=following-sibling::*[1]')
  await expect(next).toHaveAttribute('data-message-id', r.id)
  await page.keyboard.press('n')
  await expect(divider).toBeInViewport()
  // Read now; mark unread from the reply: the agent counts it as new again.
  await expect.poll(async () => (await stream(minbox, a)).messages.find((m: any) => m.id === r.id).read_at).not.toBeNull()
  await page.locator(`[data-testid="v3-message"][data-message-id="${r.id}"]`).getByTestId('msg-menu').click()
  await page.getByTestId('message-unread').click()
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page.locator(`[data-testid="agent-row"][data-session="${a.id}"]`).getByTestId('agent-unread')).toHaveText('1')
})

test('a long stream opens at the newest message; scrolled up, a new message shows a pill (no jump); older messages load on scroll-up in place', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'hello')
  await agentReply(minbox, a, /Sure — noted/)
  await open(page, minbox, a)
  await typeInTerminal(page, 'burst 230 filler line')
  await expect.poll(async () => (await stream(minbox, a)).has_more, { timeout: 30_000 }).toBe(true)
  await expect.poll(async () => (await stream(minbox, a)).messages.at(-1).body, { timeout: 30_000 }).toContain('#229')
  // Read already (unread ones would open at the first of them, under a New divider).
  const all = (await stream(minbox, a)).messages.map((m: any) => m.id)
  await api(minbox, 'POST', '/api/v3/read', { message_ids: all })
  // The terminal closed first, then a fresh load: the stream opens at its final width.
  await page.getByTestId('terminal-close').click()
  await open(page, minbox, a)
  await page.reload()
  await expect(page.getByTestId('composer-text')).toBeVisible()
  const scroller = page.getByTestId('stream-view').locator('.v-scroll')
  const atBottom = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 60)
  await expect(page.locator('[data-testid="v3-message"]').last()).toContainText('#229', { timeout: 20_000 })
  await expect.poll(atBottom, { timeout: 20_000 }).toBe(true)

  // Scroll up a little (not to the top): a new message does not move the view, a pill offers it.
  // (The terminal stays open meanwhile, so the column keeps its width.)
  await typeInTerminal(page, 'title reading')
  await page.waitForTimeout(500) // the title's re-render settles first (under load it can land late)
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
  await page.waitForTimeout(300)
  // Still scrolled up (nothing pulled it back down), else scroll up again.
  await expect
    .poll(async () => {
      if (await atBottom()) await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2))
      return atBottom()
    }, { timeout: 10_000 })
    .toBe(false)
  const sb = (await scroller.boundingBox())!
  const seenId = await page.evaluate((y) => {
    const els = Array.from(document.querySelectorAll('[data-testid="v3-message"]'))
    return els.find((e) => e.getBoundingClientRect().top > y)!.getAttribute('data-message-id')!
  }, sb.y + 40)
  const seen = page.locator(`[data-testid="v3-message"][data-message-id="${seenId}"]`)
  const y0 = (await seen.boundingBox())!.y
  await typeInTerminal(page, 'say a fresh one')
  const pill = page.getByTestId('new-message-pill')
  await expect(pill).toBeVisible({ timeout: 20_000 })
  expect(Math.abs((await seen.boundingBox())!.y - y0)).toBeLessThan(5)
  await pill.click()
  await expect.poll(atBottom, { timeout: 15_000 }).toBe(true)
  await expect(pill).toHaveCount(0)

  // Up to the top: the older messages load above; the message that was first stays where it was.
  const first = page.locator('[data-testid="v3-message"]').first()
  const firstId = (await first.getAttribute('data-message-id'))!
  const count = await page.locator('[data-testid="v3-message"]').count()
  await scroller.evaluate((el) => (el.scrollTop = 0))
  await expect.poll(() => page.locator('[data-testid="v3-message"]').count()).toBeGreaterThan(count)
  const kept = page.locator(`[data-testid="v3-message"][data-message-id="${firstId}"]`)
  const y = (await kept.boundingBox())!.y
  const box0 = (await scroller.boundingBox())!
  expect(y).toBeGreaterThan(box0.y - 5)
  expect(y).toBeLessThan(box0.y + box0.height)
})

test('fold all, the artifacts grid, O and ] [ open the files; a code comment goes with the reply', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 2000, height: 1000 })
  const a = await startAgent(minbox, 'api')
  await open(page, minbox, a)
  await typeInTerminal(page, 'kinds')
  await expectTerminal(page, /sent kinds in thr_\w+ 8/)
  await page.getByTestId('terminal-close').click()
  await expect(page.getByTestId('attachment-card').first()).toBeVisible()
  // Fold all: one line per message but the last.
  await typeInTerminal(page, 'say and one more')
  await page.getByTestId('terminal-close').click()
  await expect(page.locator('[data-testid="v3-message"]')).toHaveCount(2)
  await page.getByTestId('fold-all').click()
  await expect(page.getByTestId('v3-message-folded')).toHaveCount(1)
  await expect(page.locator('[data-testid="v3-message"]')).toHaveCount(1)
  await page.getByTestId('fold-all').click()
  await expect(page.locator('[data-testid="v3-message"]')).toHaveCount(2)
  // Artifacts: every file of the conversation.
  await page.getByTestId('artifacts-button').click()
  await expect(page.getByTestId('stream-view').getByText('main.go').first()).toBeVisible()
  await page.getByTestId('artifacts-button').click()
  // O: the newest file; ] steps on; Esc closes.
  await page.locator('body').click({ position: { x: 900, y: 10 } })
  await page.keyboard.press('o')
  const viewer = page.getByTestId('attachment-viewer')
  await expect(viewer).toBeVisible()
  await expect(viewer.getByText(/^\d+\/\d+\s*$/)).toBeVisible()
  const name1 = await viewer.getByRole('tab', { selected: true }).textContent()
  await page.keyboard.press(']')
  await expect(viewer.getByRole('tab', { selected: true })).not.toHaveText(name1!)
  // Full screen by F and back by Esc; Esc again closes.
  await page.keyboard.press('f')
  await expect(viewer.getByTestId('fullscreen')).toContainText('Exit full screen')
  await page.keyboard.press('Escape')
  await expect(viewer.getByTestId('fullscreen')).toContainText('Full screen')
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)

  // A code line comment: the chip in the reply box, then it reaches the agent with the reply.
  await page.getByRole('button', { name: /(Open|View) main\.go/ }).click()
  await expect(viewer).toHaveAttribute('data-type', 'code')
  await viewer.getByTestId('code-line-number').nth(2).dispatchEvent('mousedown')
  await viewer.getByTestId('code-line-number').nth(2).dispatchEvent('mouseup')
  await page.getByTestId('annotation-input').fill('Use fmt here.')
  await page.getByTestId('annotation-save').click()
  await expect(viewer.getByTestId('annotation')).toContainText('line 3')
  await page.getByTestId('close-viewer').click()
  await expect(page.getByTestId('annotations-chip')).toContainText('1 annotation')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('annotations-chip')).toHaveCount(0)
  await expectTerminal(page, /Feedback on the attached files/)
})

test('Q goes to the open question; a pick and typed words go in one message on Send', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'ASK about the deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  await open(page, minbox, a)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await page.getByTestId('stream-view').locator('.v-scroll').evaluate((el) => (el.scrollTop = 0))
  await page.locator('body').click({ position: { x: 900, y: 10 } })
  await page.keyboard.press('q')
  await expect(msg.getByTestId('question')).toBeInViewport()
  await msg.getByTestId('question').getByText('Oregon', { exact: true }).click()
  await expect(page.getByTestId('picks-chip')).toContainText('1 pick')
  await box(page).fill('and use the blue build')
  await page.getByTestId('composer-send').click()
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
  const s = await stream(minbox, a)
  const ans = s.messages.find((m: any) => m.answers_for === q.id)
  expect(ans.answers[0].selected).toEqual(['Oregon'])
  expect(ans.words).toBe('and use the blue build')
})

test('task view: a pick and words go together to the agent, about the task; its delivery status shows on the bubble', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  await page.goto(`${minbox.url}/#s=${a.id}&v=agent&k=${t.id}`)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await msg.getByTestId('question').getByText('Tokyo', { exact: true }).click()
  const tbox = page.getByTestId('task-composer').getByTestId('composer-text')
  await tbox.fill('ship it today')
  await page.getByTestId('task-composer').getByTestId('composer-send').click()
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
  const s = await stream(minbox, a)
  const ans = s.messages.find((m: any) => m.answers_for === q.id)
  expect(ans.words).toBe('ship it today')
  expect(ans.tasks.map((x: any) => x.task_id)).toEqual([t.id])
  await expect(userMsgs(page).last().getByTestId('delivery')).toBeVisible()
})

test("task view: the animated working line follows the task's status, live; the stream has none", async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  // The agent is idle (its turn is over), but the task is Working: the line shows, animated.
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}&k=${t.id}`)
  const working = page.getByTestId('working-line')
  // Exactly one: the task's; the agent's stream beside it has none.
  await expect(working).toHaveCount(1)
  await expect(working).toContainText('api is working on this')
  const anim = (sel: string) => working.locator(sel).first().evaluate((el) => getComputedStyle(el).animationName)
  expect(await anim('.v-dot')).toBe('v-pulse')
  expect(await anim('.v-typing-t')).toBe('v-shimmer')
  expect(await anim('.v-ell i')).toBe('v-ell')
  // Needs you, then Done: it goes; Working again: it comes back.
  await api(minbox, 'PATCH', `/api/v3/tasks/${t.id}`, { status: 'needs_you' })
  await expect(working).toHaveCount(0)
  await api(minbox, 'PATCH', `/api/v3/tasks/${t.id}`, { status: 'working' })
  await expect(working).toHaveCount(1)
  await api(minbox, 'PATCH', `/api/v3/tasks/${t.id}`, { status: 'done' })
  await expect(working).toHaveCount(0)
})

test('the conversation menu: snooze shows a notice with Unsnooze', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'hello')
  await agentReply(minbox, a, /Sure — noted/)
  await open(page, minbox, a)
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-snooze').click()
  await page.getByText('In 3 days').click()
  await expect(page.getByTestId('board')).toBeVisible()
  await open(page, minbox, a)
  await expect(page.getByTestId('stream-view').getByText(/Snoozed until/)).toBeVisible()
  await page.getByTestId('stream-view').getByRole('button', { name: 'Unsnooze' }).click()
  await expect(page.getByTestId('stream-view').getByText(/Snoozed until/)).toHaveCount(0)
})

test('Linear: link the stream to an issue from the conversation bar', async ({ page, minbox }) => {
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'hello')
  await agentReply(minbox, a, /Sure — noted/)
  await open(page, minbox, a)
  await page.getByTestId('linear-link-open').click()
  await page.getByTestId('linear-link-search').fill('safari')
  await expect(page.getByTestId('linear-link-result')).toHaveCount(1)
  await page.getByTestId('linear-link-search').press('Enter')
  await expect(page.getByTestId('linear-meta-issue')).toHaveText('ENG-201')
  await expect(page.getByTestId('linear-chip')).toContainText('ENG-201')
  // "New issue" opens the Create dialog with the search text.
  await page.getByTestId('linear-link-open').click()
  await page.getByTestId('linear-link-search').fill('Brand new problem')
  await expect(page.getByTestId('linear-link-empty')).toBeVisible()
  await page.getByTestId('linear-link-search').press('ArrowUp')
  await page.getByTestId('linear-link-search').press('Enter')
  await expect(page.getByTestId('linear-create-title')).toHaveValue('Brand new problem')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the reply box is one line high when empty; + holds full height and drawing', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await open(page, minbox, a)
    expect((await box(page).boundingBox())!.height).toBeLessThan(44)
    await page.getByTestId('reply-actions').tap()
    await expect(page.getByTestId('reply-full')).toBeVisible()
    await page.getByTestId('compose-draw').tap()
    await expect(page.getByTestId('sketch-modal')).toBeVisible()
  })
})

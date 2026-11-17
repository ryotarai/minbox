import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSession, expect, test, type Minbox } from './fixtures'

// The Topics board: the helper model (here the fake helper, fake-suggest.py) reads each thread's
// topics a few seconds after a new message, and the board shows them across threads and projects in
// three columns. The fake takes every "TOPIC: <title> | <status> | <summary>" line of the thread as a
// topic, a later line for the same title replacing the earlier one. TOPICS_SHOTS=<dir> saves
// screenshots (topics.png, topics-phone.png).

const SHOTS = process.env.TOPICS_SHOTS
// The extraction waits ~4 s for a burst to end, then runs the fake helper.
const SLOW = { timeout: 20_000 }

async function seed(page: Page, minbox: Minbox) {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'web-app')
  const other = join(minbox.dataDir, 'billing')
  mkdirSync(other, { recursive: true })
  await createSession(page, other, 'billing-svc')
  const sessions: { id: string; name: string }[] = await (await page.request.get(minbox.url + '/api/sessions')).json()
  const sid = (name: string) => sessions.find((s) => s.name === name)!.id
  const thread = async (session: string, subject: string, body: string) => {
    const r = await page.request.post(`${minbox.url}/api/sessions/${sid(session)}/threads`, { data: { subject, body } })
    expect(r.ok()).toBe(true)
    return (await r.json()).id as string
  }
  const search = await thread(
    'web-app',
    'Search for the inbox',
    'Add search to the inbox.\nTOPIC: Search box UI | in_progress | Building the search field and results list\nTOPIC: Index format | waiting_on_you | Pick SQLite FTS5 or plain LIKE before indexing' +
      '\nTOPIC-DETAIL: Search box UI | The **search field** sits above the thread list.\\nResults narrow as you type.' +
      '\nTOPIC-TASK: Search box UI | [x] Add the field\nTOPIC-TASK: Search box UI | [ ] Show the results\nTOPIC-TASK: Search box UI | [ ] Keyboard shortcut',
  )
  const billing = await thread(
    'billing-svc',
    'Invoices are off by a cent',
    'Invoices round wrong.\nTOPIC: Rounding bug | in_progress | Reproduced with 3 line items; fixing the sum\nTOPIC: Release notes v1.4 | done | Published to the changelog',
  )
  return { search, billing, sid }
}

const col = (page: Page, status: string) => page.getByTestId(`topics-col-${status}`)
const card = (page: Page, status: string, title: string) => col(page, status).getByTestId('topic-card').filter({ hasText: title })

test('topics from several threads land in their columns, move live and open their thread', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1400, height: 820 })
  const { search } = await seed(page, minbox)

  // Topics is on by default: its entry is in the rail.
  await page.getByTestId('project-rail').getByTestId('open-topics').click()
  await expect(page.getByTestId('topics')).toBeVisible()
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible(SLOW)
  await expect(card(page, 'waiting_on_you', 'Index format')).toBeVisible(SLOW)
  await expect(card(page, 'in_progress', 'Rounding bug')).toBeVisible(SLOW)
  await expect(card(page, 'done', 'Release notes v1.4')).toBeVisible(SLOW)
  await expect(col(page, 'done')).toContainText('last 7 days')
  // A card: title, summary, its thread and project, when.
  const idx = card(page, 'waiting_on_you', 'Index format')
  await expect(idx.getByTestId('topic-summary')).toHaveText('Pick SQLite FTS5 or plain LIKE before indexing')
  await expect(idx.getByTestId('topic-thread')).toContainText('Search for the inbox')
  await expect(idx.getByTestId('topic-thread')).toContainText(/· \S+/) // the project's name
  await expect(idx.locator('time')).toHaveText(/just now|ago/)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/topics.png` })

  // A new message in the thread: the board follows without a reload, and the card keeps its id.
  const id = await idx.getAttribute('data-topic-id')
  const r = await page.request.post(`${minbox.url}/api/threads/${search}/reply`, { data: { words: 'Use FTS5.\nTOPIC: Index format | done | Chose SQLite FTS5' } })
  expect(r.ok()).toBe(true)
  await expect(card(page, 'done', 'Index format')).toBeVisible(SLOW)
  await expect(card(page, 'done', 'Index format')).toHaveAttribute('data-topic-id', id!)
  await expect(card(page, 'done', 'Index format').getByTestId('topic-summary')).toHaveText('Chose SQLite FTS5')
  await expect(col(page, 'waiting_on_you').getByTestId('topic-card')).toHaveCount(0)

  // The project filter: only that project's topics.
  await page.getByTestId('topics-project').click()
  await page.getByRole('menuitem', { name: 'billing' }).click()
  await expect(page.getByTestId('topics-project')).toContainText('billing')
  await expect(page.getByTestId('topic-card')).toHaveCount(2)
  await expect(card(page, 'in_progress', 'Rounding bug')).toBeVisible()
  await page.getByTestId('topics-project').click()
  await page.getByRole('menuitem', { name: 'All projects' }).click()
  await expect(page.getByTestId('topic-card')).toHaveCount(4)

  // A card opens its pane; the pane's thread link opens the thread.
  await card(page, 'in_progress', 'Search box UI').click()
  await expect(page.getByTestId('topic-pane')).toBeVisible()
  await page.getByTestId('topic-pane-thread').click()
  await expect(page.getByTestId('topics')).toHaveCount(0)
  await expect(page.getByTestId('thread-subject')).toHaveText('Search for the inbox')

  // The old Board address opens Topics.
  await page.goto(minbox.url + '/#v=board')
  await expect(page.getByTestId('topics')).toBeVisible()
})

test('phone: the columns are tabs; a card opens its topic full screen, then its thread', async ({ page, minbox }) => {
  await seed(page, minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toBeVisible()
  await page.getByTestId('project-switch').click()
  await page.getByTestId('project-sheet').getByTestId('open-topics').click()
  await expect(page.getByTestId('topics')).toBeVisible()

  // Waiting on you first.
  await expect(page.getByTestId('topics-tab-waiting_on_you')).toHaveAttribute('aria-checked', 'true')
  await expect(card(page, 'waiting_on_you', 'Index format')).toBeVisible(SLOW)
  await expect(page.getByTestId('topics-tab-in_progress')).toContainText('2', SLOW)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/topics-phone.png` })
  await page.getByTestId('topics-tab-in_progress').click()
  await expect(card(page, 'in_progress', 'Rounding bug')).toBeVisible()
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible()
  await page.getByTestId('topics-tab-done').click()
  await expect(page.getByTestId('topics-col-done')).toContainText('Done in the last 7 days')
  await expect(card(page, 'done', 'Release notes v1.4')).toBeVisible()
  // No horizontal scroll at phone width.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  // A tap: the topic full screen (no board behind it), Back returns to the board.
  await card(page, 'done', 'Release notes v1.4').click()
  const pane = page.getByTestId('topic-pane')
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('topics-col-done')).toHaveCount(0)
  await expect(page.getByTestId('topic-pane-title')).toHaveText('Release notes v1.4')
  await expect(page.getByTestId('topic-pane-status')).toHaveText('Done')
  // No prefix chip: the "[Topic: …]" prefix is added on send only.
  await expect(page.getByTestId('topic-pane-prefix')).toHaveCount(0)
  await expect(page.getByTestId('topic-pane-input')).toHaveAttribute('placeholder', 'Message the thread about this topic…')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByTestId('topic-pane-back').click()
  await expect(pane).toHaveCount(0)
  await expect(card(page, 'done', 'Release notes v1.4')).toBeVisible()
  await card(page, 'done', 'Release notes v1.4').click()
  await page.getByTestId('topic-pane-thread').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Invoices are off by a cent')
})

test('turned off: no new topics are read, and the board says so', async ({ page, minbox }) => {
  await fetch(minbox.url + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: minbox.url },
    body: JSON.stringify({ topics: false }),
  })
  await seed(page, minbox)
  await page.goto(minbox.url + '/#v=topics')
  await expect(page.getByTestId('topics-off')).toBeVisible()
  await page.waitForTimeout(6000) // past the extraction's debounce
  await page.reload()
  await expect(page.getByTestId('topic-card')).toHaveCount(0)
  await expect(page.getByTestId('project-rail').getByTestId('open-topics')).toHaveCount(0)
})

/** The topics as the server has them: title -> status. */
async function stored(page: Page, minbox: Minbox): Promise<Record<string, string>> {
  const r = await (await page.request.get(minbox.url + '/api/topics')).json()
  return Object.fromEntries(r.topics.map((t: { title: string; status: string }) => [t.title, t.status]))
}

test('moving cards: drag, the menu; the move holds and the next extraction is told about it', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1400, height: 820 })
  const { search } = await seed(page, minbox)
  await page.goto(minbox.url + '/#v=topics')
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible(SLOW)
  await expect(card(page, 'in_progress', 'Rounding bug')).toBeVisible(SLOW)

  // Drag a card from In progress to Done: the column lights up under it, the card moves, and the
  // move is stored (it is still there after a reload).
  const ui = card(page, 'in_progress', 'Search box UI')
  const id = await ui.getAttribute('data-topic-id')
  const box = (await ui.boundingBox())!
  const done = (await col(page, 'done').boundingBox())!
  await page.mouse.move(box.x + 30, box.y + 15)
  await page.mouse.down()
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 4 })
  await page.mouse.move(done.x + done.width / 2, done.y + done.height / 2, { steps: 8 })
  await expect(col(page, 'done')).toHaveAttribute('data-drop-over', 'true')
  await page.mouse.up()
  await expect(card(page, 'done', 'Search box UI')).toHaveAttribute('data-topic-id', id!)
  await expect(col(page, 'in_progress').getByTestId('topic-card').filter({ hasText: 'Search box UI' })).toHaveCount(0)
  await expect(col(page, 'done')).not.toHaveAttribute('data-drop-over', 'true')
  await page.reload()
  await expect(card(page, 'done', 'Search box UI')).toHaveAttribute('data-manual', 'true')
  expect((await stored(page, minbox))['Search box UI']).toBe('done')

  // Playwright's dragTo: back to In progress, then Done again.
  await card(page, 'done', 'Search box UI').dragTo(col(page, 'in_progress'))
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible()
  await card(page, 'in_progress', 'Search box UI').dragTo(col(page, 'done'))
  await expect(card(page, 'done', 'Search box UI')).toBeVisible()

  // The menu (right-click): Move to › Waiting on you; the current column is disabled.
  await card(page, 'in_progress', 'Rounding bug').click({ button: 'right' })
  const menu = page.getByTestId('topic-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('topic-move-in_progress')).toBeDisabled()
  await menu.getByTestId('topic-move-waiting_on_you').click()
  await expect(menu).toHaveCount(0)
  await expect(card(page, 'waiting_on_you', 'Rounding bug')).toBeVisible()
  // The "…" button (on hover): Index format to In progress.
  await card(page, 'waiting_on_you', 'Index format').hover()
  await card(page, 'waiting_on_you', 'Index format').getByTestId('topic-more').click()
  await page.getByTestId('topic-menu').getByTestId('topic-move-in_progress').click()
  await expect(card(page, 'in_progress', 'Index format')).toBeVisible()
  await expect(page).toHaveURL(/v=topics/) // the button did not open the thread
  expect(await stored(page, minbox)).toMatchObject({ 'Search box UI': 'done', 'Rounding bug': 'waiting_on_you', 'Index format': 'in_progress' })

  // A new message in the thread: the extraction runs again. Its prompt says the person moved the
  // cards (the fake helper keeps a moved card's column and says so in the summary); its answer is
  // then the status, and the marker is gone.
  const r = await page.request.post(`${minbox.url}/api/threads/${search}/reply`, { data: { words: 'Next.\nTOPIC: Docs | in_progress | Write the docs' } })
  expect(r.ok()).toBe(true)
  await expect(card(page, 'in_progress', 'Docs')).toBeVisible(SLOW)
  await expect(card(page, 'done', 'Search box UI').getByTestId('topic-summary')).toHaveText('Building the search field and results list (kept your move)')
  await expect(card(page, 'in_progress', 'Index format').getByTestId('topic-summary')).toContainText('(kept your move)')
  await expect(card(page, 'done', 'Search box UI')).not.toHaveAttribute('data-manual', 'true')
  await expect(card(page, 'done', 'Search box UI')).toHaveAttribute('data-topic-id', id!)
  // The other thread had no new message: its move still holds, marked.
  await expect(card(page, 'waiting_on_you', 'Rounding bug')).toHaveAttribute('data-manual', 'true')
})

test('keyboard: ⇧T opens Topics; arrows and HJKL move the focus, 1 2 3 move the card, Enter opens', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1400, height: 820 })
  await seed(page, minbox)
  await page.goto(minbox.url + '/#')
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press('Shift+T')
  await expect(page.getByTestId('topics')).toBeVisible()
  await expect(card(page, 'waiting_on_you', 'Index format')).toBeVisible(SLOW)
  await expect(col(page, 'in_progress').getByTestId('topic-card')).toHaveCount(2, SLOW)
  const focused = page.locator('[data-testid="topic-card"][data-focused="true"]')
  await expect(focused).toHaveCount(0)

  // j: the first card of the first column, focused (ring and DOM focus).
  await page.keyboard.press('j')
  const inProg = col(page, 'in_progress').getByTestId('topic-card')
  await expect(inProg.nth(0)).toHaveAttribute('data-focused', 'true')
  await expect(inProg.nth(0)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(inProg.nth(1)).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('k')
  await expect(inProg.nth(0)).toHaveAttribute('data-focused', 'true')
  // l / →: the next column.
  await page.keyboard.press('l')
  await expect(card(page, 'waiting_on_you', 'Index format')).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(card(page, 'done', 'Release notes v1.4')).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('h')
  await expect(card(page, 'waiting_on_you', 'Index format')).toHaveAttribute('data-focused', 'true')

  // 3: to Done; the focus follows the card. 1: back to In progress.
  await page.keyboard.press('3')
  await expect(card(page, 'done', 'Index format')).toHaveAttribute('data-focused', 'true')
  await expect(col(page, 'waiting_on_you').getByTestId('topic-card')).toHaveCount(0)
  await page.keyboard.press('1')
  await expect(card(page, 'in_progress', 'Index format')).toHaveAttribute('data-focused', 'true')
  // ← from Done skips nothing; from In progress there is no column further left.
  await page.keyboard.press('ArrowLeft')
  await expect(card(page, 'in_progress', 'Index format')).toHaveAttribute('data-focused', 'true')
  await page.keyboard.press('2')
  await expect(card(page, 'waiting_on_you', 'Index format')).toHaveAttribute('data-focused', 'true')
  await page.reload()
  await expect(card(page, 'waiting_on_you', 'Index format')).toHaveAttribute('data-manual', 'true')
  expect((await stored(page, minbox))['Index format']).toBe('waiting_on_you')

  // Shift+F10 opens the focused card's menu.
  await page.keyboard.press('j')
  await expect(focused).toHaveCount(1)
  await expect(focused).toBeFocused()
  await page.keyboard.press('Shift+F10')
  await expect(page.getByTestId('topic-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('topic-menu')).toHaveCount(0)

  // The shortcuts list has them.
  await page.keyboard.press('?')
  await expect(page.getByTestId('shortcuts')).toContainText('Move to column')
  await expect(page.getByTestId('shortcuts')).toContainText('⇧T')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('shortcuts')).toHaveCount(0)
  await expect(page.getByTestId('topics')).toBeVisible()

  // Enter opens the focused card's thread.
  await page.keyboard.press('l')
  await expect(card(page, 'waiting_on_you', 'Index format')).toHaveAttribute('data-focused', 'true')
  await expect(card(page, 'waiting_on_you', 'Index format')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('topics')).toHaveCount(0)
  await expect(page.getByTestId('thread-subject')).toHaveText('Search for the inbox')
})

test('the topic pane: summary, checklist, related messages; a message from it reaches the thread with the topic named', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  const { search } = await seed(page, minbox)
  await page.goto(minbox.url + '/#v=topics')
  const ui = card(page, 'in_progress', 'Search box UI')
  await expect(ui).toBeVisible(SLOW)
  await expect(page.getByTestId('topic-pane')).toHaveCount(0)

  // A click selects the card and opens its pane beside the board (the thread does not open).
  await ui.click()
  const pane = page.getByTestId('topic-pane')
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('topics-col-in_progress')).toBeVisible()
  await expect(ui).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('topic-pane-title')).toHaveText('Search box UI')
  await expect(page.getByTestId('topic-pane-status')).toHaveText('In progress')
  await expect(page.getByTestId('topic-pane-thread')).toContainText('Search for the inbox')
  // The detail, as Markdown.
  await expect(page.getByTestId('topic-pane-detail').locator('strong')).toHaveText('search field')
  await expect(page.getByTestId('topic-pane-detail')).toContainText('Results narrow as you type.')
  // The steps: read-only checkboxes and the progress.
  await expect(page.getByTestId('topic-pane-progress')).toHaveText('1/3 done')
  const tasks = page.getByTestId('topic-task')
  await expect(tasks).toHaveCount(3)
  await expect(tasks.nth(0)).toHaveAttribute('data-done', 'true')
  await expect(tasks.nth(0).getByRole('checkbox')).toHaveAttribute('aria-checked', 'true')
  await expect(tasks.nth(1)).toHaveAttribute('data-done', 'false')
  await expect(tasks.nth(1)).toHaveText('Show the results')
  // The related messages: the one that names the topic.
  const related = page.getByTestId('topic-message')
  await expect(related).toHaveCount(1)
  await expect(related.first().getByTestId('topic-message-excerpt')).toContainText('Add search to the inbox.')
  // The message box: no prefix chip (the prefix is added on send), a hint in the placeholder.
  await expect(page.getByTestId('topic-pane-prefix')).toHaveCount(0)
  await expect(page.getByTestId('topic-pane-input')).toHaveAttribute('placeholder', /Message the thread about this topic/)
  await expect(page.getByTestId('topic-pane-send')).toBeDisabled()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/topics-pane.png` })

  // Another card: the pane follows. Esc closes it; the board stays.
  await card(page, 'waiting_on_you', 'Index format').click()
  await expect(page.getByTestId('topic-pane-title')).toHaveText('Index format')
  await expect(page.getByTestId('topic-pane-progress')).toHaveCount(0)
  await expect(page.getByTestId('topic-pane-tasks')).toContainText('No separate steps')
  await page.keyboard.press('Escape')
  await expect(pane).toHaveCount(0)
  await expect(page.getByTestId('topics')).toBeVisible()
  // Space on the focused card opens it again; j moves the selection along; Enter still opens the thread (below).
  await expect(card(page, 'waiting_on_you', 'Index format')).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('topic-pane-title')).toHaveText('Index format')
  await page.keyboard.press('h')
  const sel = col(page, 'in_progress').locator('[data-testid="topic-card"][data-selected="true"]')
  await expect(sel).toHaveCount(1)
  await expect(page.getByTestId('topic-pane-title')).toHaveText((await sel.getByTestId('topic-title').textContent())!)
  await ui.click()
  await expect(page.getByTestId('topic-pane-title')).toHaveText('Search box UI')
  await expect(ui).toHaveAttribute('data-selected', 'true')

  // R: the message box. Send: the thread gets "[Topic: …]" then the text, and the agent takes it.
  await page.keyboard.press('r')
  const input = page.getByTestId('topic-pane-input')
  await expect(input).toBeFocused()
  await input.fill('Debounce the search by 200 ms.')
  await page.getByTestId('topic-pane-send').click()
  await expect(input).toHaveValue('')
  const want = '[Topic: Search box UI]\nDebounce the search by 200 ms.'
  type Msg = { author: string; words?: string; body: string; delivery?: string }
  const sent = async () => {
    const th: { messages: Msg[] } = await (await page.request.get(`${minbox.url}/api/threads/${search}`)).json()
    return th.messages.find((m) => m.author === 'user' && (m.words || m.body) === want)
  }
  await expect.poll(async () => (await sent())?.delivery, SLOW).toBe('delivered')
  // The new message names the topic: the next extraction links it, and the pane shows it.
  await expect(related).toHaveCount(2, SLOW)
  await expect(related.nth(1).getByTestId('topic-message-excerpt')).toContainText('[Topic: Search box UI] Debounce the search by 200 ms.')

  // A related message opens the thread at it.
  await related.first().click()
  await expect(page.getByTestId('topics')).toHaveCount(0)
  await expect(page.getByTestId('thread-subject')).toHaveText('Search for the inbox')
  await expect(page.locator('[data-testid="message"][data-jumped="true"]')).toContainText('Add search to the inbox.')
  await expect(page.locator('[data-testid="message"]').filter({ hasText: 'Debounce the search by 200 ms.' })).toContainText('[Topic: Search box UI]')

  // Enter on the focused card still opens the thread.
  await page.goto(minbox.url + '/#v=topics')
  await expect(ui).toBeVisible(SLOW)
  await page.keyboard.press('j')
  await expect(col(page, 'in_progress').getByTestId('topic-card').first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('topics')).toHaveCount(0)

  // The shortcuts list has the pane's keys.
  await page.keyboard.press('?')
  await expect(page.getByTestId('shortcuts')).toContainText('Show topic pane')
  await expect(page.getByTestId('shortcuts')).toContainText('Message the thread')
})

test('phone: the topic pane is a full screen with its message box', async ({ page, minbox }) => {
  await seed(page, minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#v=topics')
  await page.getByTestId('topics-tab-in_progress').click()
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible(SLOW)
  await card(page, 'in_progress', 'Search box UI').click()
  await expect(page.getByTestId('topic-pane')).toBeVisible()
  await expect(page.getByTestId('topic-pane-progress')).toHaveText('1/3 done')
  await expect(page.getByTestId('topic-message')).toHaveCount(1)
  await expect(page.getByTestId('topic-pane-input')).toBeVisible()
  await expect(page.getByTestId('topic-pane-back')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/topics-pane-phone.png` })
})

test.describe('phone moves', () => {
  test.use({ hasTouch: true })

  test('phone: a long press or "…" opens Move to; the card goes to its tab', async ({ page, minbox }) => {
    await seed(page, minbox)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(minbox.url + '/#v=topics')
    await expect(page.getByTestId('topics')).toBeVisible()
    const idx = card(page, 'waiting_on_you', 'Index format')
    await expect(idx).toBeVisible(SLOW)
    // No dragging on a phone.
    await expect(idx).toHaveAttribute('draggable', 'false')

    // A long press: the menu, and the thread does not open.
    const cdp = await page.context().newCDPSession(page)
    const b = (await idx.boundingBox())!
    const x = Math.round(b.x + b.width / 3)
    const y = Math.round(b.y + b.height / 2)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.waitForTimeout(800)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const menu = page.getByTestId('topic-menu')
    await expect(menu).toBeVisible()
    await page.waitForTimeout(300)
    await expect(page.getByTestId('topics')).toBeVisible()
    const item = (await menu.getByTestId('topic-move-done').boundingBox())!
    await page.touchscreen.tap(item.x + item.width / 2, item.y + item.height / 2)
    await expect(menu).toHaveCount(0)
    await expect(col(page, 'waiting_on_you').getByTestId('topic-card')).toHaveCount(0)
    await expect(page.getByTestId('topics-tab-done')).toContainText('2')
    await page.getByTestId('topics-tab-done').click()
    await expect(card(page, 'done', 'Index format')).toBeVisible()

    // The "…" button: back to In progress.
    const more = (await card(page, 'done', 'Index format').getByTestId('topic-more').boundingBox())!
    await page.touchscreen.tap(more.x + more.width / 2, more.y + more.height / 2)
    await menu.getByTestId('topic-move-in_progress').tap()
    await page.getByTestId('topics-tab-in_progress').click()
    await expect(card(page, 'in_progress', 'Index format')).toBeVisible()
    await expect(page.getByTestId('topics')).toBeVisible()
    expect((await stored(page, minbox))['Index format']).toBe('in_progress')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

test('the topic pane: Done moves the topic to Done (it holds), Reopen brings it back', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1400, height: 820 })
  await seed(page, minbox)
  await page.goto(minbox.url + '/#v=topics')
  const ui = card(page, 'in_progress', 'Search box UI')
  await expect(ui).toBeVisible(SLOW)
  await ui.click()
  const pane = page.getByTestId('topic-pane')
  await expect(page.getByTestId('topic-pane-reopen')).toHaveCount(0)
  await expect(page.getByTestId('topic-pane-done')).toHaveAttribute('title', /\(3\)/)

  // Done: the card goes to Done, the pane stays open on it with the new status.
  await page.getByTestId('topic-pane-done').click()
  await expect(card(page, 'done', 'Search box UI')).toBeVisible()
  await expect(card(page, 'in_progress', 'Search box UI')).toHaveCount(0)
  await expect(pane).toBeVisible()
  await expect(page.getByTestId('topic-pane-title')).toHaveText('Search box UI')
  await expect(page.getByTestId('topic-pane-status')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('topic-pane-done')).toHaveCount(0)
  await expect(page.getByTestId('topic-pane-reopen')).toBeVisible()
  await expect.poll(async () => (await stored(page, minbox))['Search box UI']).toBe('done')

  // It holds after a reload.
  await page.reload()
  await expect(card(page, 'done', 'Search box UI')).toBeVisible(SLOW)
  await expect(card(page, 'in_progress', 'Search box UI')).toHaveCount(0)

  // Reopen: back to In progress.
  await card(page, 'done', 'Search box UI').click()
  await page.getByTestId('topic-pane-reopen').click()
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible()
  await expect(page.getByTestId('topic-pane-status')).toHaveAttribute('data-status', 'in_progress')
  await expect(page.getByTestId('topic-pane-done')).toBeVisible()
  await expect.poll(async () => (await stored(page, minbox))['Search box UI']).toBe('in_progress')
})

test('phone: the topic pane has Done and Reopen; the board follows', async ({ page, minbox }) => {
  await seed(page, minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#v=topics')
  await page.getByTestId('topics-tab-in_progress').click()
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible(SLOW)
  await card(page, 'in_progress', 'Search box UI').click()
  await expect(page.getByTestId('topic-pane')).toBeVisible()
  await page.getByTestId('topic-pane-done').click()
  await expect(page.getByTestId('topic-pane')).toBeVisible()
  await expect(page.getByTestId('topic-pane-status')).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('topic-pane-reopen')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect.poll(async () => (await stored(page, minbox))['Search box UI']).toBe('done')

  // Back on the board: the card is in Done, and stays there after a reload.
  await page.getByTestId('topic-pane-back').click()
  await page.getByTestId('topics-tab-done').click()
  await expect(card(page, 'done', 'Search box UI')).toBeVisible()
  await page.reload()
  await page.getByTestId('topics-tab-done').click()
  await expect(card(page, 'done', 'Search box UI')).toBeVisible(SLOW)

  // Reopen from the pane.
  await card(page, 'done', 'Search box UI').click()
  await page.getByTestId('topic-pane-reopen').click()
  await expect(page.getByTestId('topic-pane-status')).toHaveAttribute('data-status', 'in_progress')
  await expect.poll(async () => (await stored(page, minbox))['Search box UI']).toBe('in_progress')
  await page.getByTestId('topic-pane-back').click()
  await page.getByTestId('topics-tab-in_progress').click()
  await expect(card(page, 'in_progress', 'Search box UI')).toBeVisible()
})

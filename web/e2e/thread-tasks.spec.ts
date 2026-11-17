import type { Page } from '@playwright/test'
import { createSession, expect, test, type Minbox } from './fixtures'

// A thread's Tasks pane: the open thread's tasks (topics in the API) beside the thread on a desktop,
// between the thread and the agent terminal when that is open; full screen on a phone. The fake
// agent (fake-claude.py) keeps a task for every "TOPIC: <title> | <status> | <summary>" line of a
// message it receives, through the agent API (create_task / update_task).
// THREAD_TASKS_SHOTS=<dir> saves screenshots (thread-tasks.png, thread-tasks-phone.png).

const SHOTS = process.env.THREAD_TASKS_SHOTS
const SLOW = { timeout: 20_000 }
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function seed(page: Page, minbox: Minbox) {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'web-app')
  const sessions: { id: string; name: string }[] = await (await page.request.get(minbox.url + '/api/sessions')).json()
  const sid = sessions.find((s) => s.name === 'web-app')!.id
  const thread = async (subject: string, body: string) => {
    const r = await page.request.post(`${minbox.url}/api/sessions/${sid}/threads`, { data: { subject, body } })
    expect(r.ok()).toBe(true)
    return (await r.json()).id as string
  }
  const search = await thread(
    'Search for the inbox',
    'Add search to the inbox.\nTOPIC: Search box UI | in_progress | Building the search field and results list\nTOPIC: Index format | waiting_on_you | Pick SQLite FTS5 or plain LIKE before indexing' +
      '\nTOPIC-DETAIL: Search box UI | The **search field** sits above the thread list.' +
      '\nTOPIC-TASK: Search box UI | [x] Add the field\nTOPIC-TASK: Search box UI | [ ] Show the results',
  )
  const other = await thread('Invoices are off by a cent', 'Invoices round wrong.\nTOPIC: Rounding bug | in_progress | Fixing the sum')
  const empty = await thread('Just a note', 'Nothing to track here.')
  return { sid, search, other, empty }
}

const pane = (page: Page) => page.getByTestId('thread-tasks')
const card = (page: Page, title: string) => pane(page).getByTestId('topic-card').filter({ hasText: title })

test('desktop: the toggle shows this thread’s tasks beside it, before the terminal; select, Done, reveal, persist, close, ⌘K', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { sid, search, other, empty } = await seed(page, minbox)
  await page.goto(`${minbox.url}/#s=${sid}&t=${search}`)
  await expect(page.getByTestId('thread-subject')).toHaveText('Search for the inbox')

  // Hidden by default; the header button shows it.
  const toggle = page.getByTestId('tasks-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAttribute('title', /Show tasks/)
  await expect(pane(page)).toHaveCount(0)
  await toggle.click()
  await expect(pane(page)).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAttribute('title', 'Hide tasks')

  // Only this thread's tasks, grouped by status.
  await expect(card(page, 'Search box UI')).toBeVisible(SLOW)
  await expect(pane(page).getByTestId('thread-tasks-in_progress')).toContainText('Search box UI')
  await expect(pane(page).getByTestId('thread-tasks-waiting_on_you')).toContainText('Index format')
  await expect(pane(page).getByTestId('topic-card')).toHaveCount(2)
  await expect(pane(page)).not.toContainText('Rounding bug')
  await expect(pane(page).getByTestId('topic-thread')).toHaveCount(0)

  // Right of the thread (terminal hidden); with the terminal open it sits between them: thread | tasks | terminal.
  const box = async (id: string) => (await page.getByTestId(id).boundingBox())!
  if ((await page.getByTestId('terminal-toggle').getAttribute('aria-pressed')) === 'true') await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  expect((await box('tasks-pane')).x).toBeGreaterThan((await box('thread-pane')).x)
  if ((await page.getByTestId('terminal-toggle').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  const [th, tk, tm] = [await box('thread-pane'), await box('tasks-pane'), await box('terminal')]
  expect(th.x + th.width).toBeLessThanOrEqual(tk.x + 2)
  expect(tk.x + tk.width).toBeLessThanOrEqual(tm.x + 2)
  expect(tk.width).toBeGreaterThan(250)
  if (SHOTS) {
    await card(page, 'Search box UI').click()
    await expect(page.getByTestId('topic-pane-detail')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/thread-tasks.png` })
    await page.getByTestId('topic-pane-back').click()
  }

  // Selecting a task: its detail in the pane (no thread link; a message box), Back to the list.
  await card(page, 'Search box UI').click()
  const detail = pane(page).getByTestId('topic-pane')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('topic-pane-title')).toHaveText('Search box UI')
  await expect(detail.getByTestId('topic-pane-progress')).toHaveText('1/2 done')
  await expect(detail.getByTestId('topic-pane-detail').locator('strong')).toHaveText('search field')
  await expect(detail.getByTestId('topic-pane-thread')).toHaveCount(0)
  await expect(detail.getByTestId('topic-pane-compose')).toBeVisible()

  // R in the pane: the task's box (the thread's own box stays put); Esc leaves it. Outside the pane,
  // R is the thread's box as before.
  await detail.getByTestId('topic-pane-detail').click()
  await page.keyboard.press('r')
  const input = detail.getByTestId('topic-pane-input')
  await expect(input).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(input).not.toBeFocused()
  await expect(detail).toBeVisible()
  await page.getByTestId('thread-subject').click()
  await page.keyboard.press('r')
  await expect(input).not.toBeFocused()
  await expect(page.getByTestId('reply-box')).toBeFocused()
  await page.getByTestId('reply-box').blur()
  // Text selected in the thread wins over the pane: R quotes it, also while the keyboard is still
  // in the pane (and the bubble has not caught up yet).
  const msgText = page.getByTestId('message').getByText('Add search to the inbox.')
  const mb = (await msgText.boundingBox())!
  await page.mouse.dblclick(mb.x + 6, mb.y + 8) // "Add", on the first line
  await pane(page).focus()
  await page.keyboard.press('r')
  await expect(input).not.toBeFocused()
  await expect(page.getByTestId('reply-box')).toBeFocused()
  await expect(page.getByTestId('reply-box')).toHaveValue('> Add\n\n')
  await page.getByTestId('reply-box').fill('')
  await page.getByTestId('reply-box').blur()

  // Send: the thread beside it shows the message at once (the context as a "Task" chip), and the
  // agent gets "[Task: …]", the context and the text.
  await input.fill('Use a 200 ms debounce.')
  await input.press(`${MOD}+Enter`)
  await expect(input).toHaveValue('')
  const sentMsg = page.locator('[data-testid="message"]').filter({ hasText: 'Use a 200 ms debounce.' })
  await expect(sentMsg).toBeVisible()
  await expect(sentMsg.getByTestId('task-context-title')).toHaveText('Search box UI')
  type Msg = { author: string; words?: string; body: string; delivery?: string }
  const sent = async (text: string) => {
    const th: { messages: Msg[] } = await (await page.request.get(`${minbox.url}/api/threads/${search}`)).json()
    return th.messages.find((m) => m.author === 'user' && (m.words || m.body).endsWith(`\n\n${text}`))
  }
  await expect.poll(async () => (await sent('Use a 200 ms debounce.'))?.delivery, SLOW).toBe('delivered')
  const words = (await sent('Use a 200 ms debounce.'))!.words!
  expect(words.startsWith('[Task: Search box UI]\n> Task context (from minbox): Building the search field and results list\n')).toBe(true)
  expect(words).toContain('Steps: 1/2 done; open: Show the results')
  // A draft per task: typed text stays with its task.
  await input.fill('half a thought')
  await detail.getByTestId('topic-pane-back').click()
  await card(page, 'Search box UI').click()
  await expect(pane(page).getByTestId('topic-pane-input')).toHaveValue('half a thought')
  await pane(page).getByTestId('topic-pane-input').fill('')

  // A related message: shown in the thread (the same thread stays open).
  await detail.getByTestId('topic-message').first().click()
  await expect(page.locator('[data-testid="message"][data-jumped="true"]')).toContainText('Add search to the inbox.')
  await expect(page.getByTestId('thread-subject')).toHaveText('Search for the inbox')

  // Done: it moves to Done, stored.
  await detail.getByTestId('topic-pane-done').click()
  await expect(detail.getByTestId('topic-pane-status')).toHaveText('Done')
  await expect(detail.getByTestId('topic-pane-reopen')).toBeVisible()
  await detail.getByTestId('topic-pane-back').click()
  await expect(pane(page).getByTestId('thread-tasks-done')).toContainText('Search box UI')
  await expect
    .poll(async () => {
      const r = await (await page.request.get(`${minbox.url}/api/topics?thread=${search}`)).json()
      return r.topics.find((t: { title: string }) => t.title === 'Search box UI')?.status
    })
    .toBe('done')
  // The menu moves too.
  await card(page, 'Index format').hover()
  await card(page, 'Index format').getByTestId('topic-more').click()
  await expect(page.getByTestId('topic-open')).toHaveCount(0)
  await page.getByTestId('topic-move-in_progress').click()
  await expect(pane(page).getByTestId('thread-tasks-in_progress')).toContainText('Index format')

  // The open state survives a reload.
  await page.reload()
  await expect(pane(page)).toBeVisible()
  await expect(card(page, 'Index format')).toBeVisible()

  // Another thread: its own tasks; a thread with none says so.
  await page.goto(`${minbox.url}/#s=${sid}&t=${other}`)
  await expect(page.getByTestId('thread-subject')).toHaveText('Invoices are off by a cent')
  await expect(card(page, 'Rounding bug')).toBeVisible(SLOW)
  await expect(pane(page).getByTestId('topic-card')).toHaveCount(1)
  await page.goto(`${minbox.url}/#s=${sid}&t=${empty}`)
  await expect(page.getByTestId('thread-subject')).toHaveText('Just a note')
  await expect(pane(page).getByTestId('thread-tasks-empty')).toHaveText('No tasks yet — the agent adds them when it starts work in this thread.')

  // The × closes it (and that holds too).
  await page.getByTestId('tasks-close').click()
  await expect(pane(page)).toHaveCount(0)
  await expect(page.getByTestId('tasks-toggle')).toHaveAttribute('aria-pressed', 'false')
  await page.reload()
  await expect(page.getByTestId('thread-subject')).toHaveText('Just a note')
  await expect(pane(page)).toHaveCount(0)

  // ⌘K: Show tasks / Hide tasks.
  await page.keyboard.press(`${MOD}+k`)
  await page.getByTestId('palette-input').fill('show tasks')
  await expect(page.getByTestId('palette-item').first()).toContainText('Show tasks')
  await page.keyboard.press('Enter')
  await expect(pane(page)).toBeVisible()
  await page.keyboard.press(`${MOD}+k`)
  await page.getByTestId('palette-input').fill('hide tasks')
  await expect(page.getByTestId('palette-item').first()).toContainText('Hide tasks')
  await page.keyboard.press('Enter')
  await expect(pane(page)).toHaveCount(0)
})

const status = async (page: Page, minbox: Minbox, thread: string, title: string) => {
  const r = await (await page.request.get(`${minbox.url}/api/topics?thread=${thread}`)).json()
  return r.topics.find((t: { title: string }) => t.title === title)?.status as string | undefined
}

test('desktop: a task card’s check button marks it done on hover (it holds), Reopen brings it back; the list stays', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  const { sid, search } = await seed(page, minbox)
  await page.goto(`${minbox.url}/#s=${sid}&t=${search}`)
  await page.getByTestId('tasks-toggle').click()
  const ui = card(page, 'Search box UI')
  await expect(ui).toBeVisible(SLOW)
  const btn = ui.getByTestId('topic-done')
  await page.mouse.move(0, 0)
  await expect(btn).toBeHidden()
  await ui.hover()
  await expect(btn).toBeVisible()
  await expect(btn).toHaveAttribute('title', 'Mark done (3)')
  await btn.click()
  await expect(pane(page).getByTestId('thread-tasks-done')).toContainText('Search box UI')
  // The click did not open the task.
  await expect(pane(page).getByTestId('topic-pane')).toHaveCount(0)
  await expect.poll(() => status(page, minbox, search, 'Search box UI')).toBe('done')

  await page.reload()
  await expect(pane(page).getByTestId('thread-tasks-done')).toContainText('Search box UI', SLOW)
  const done = card(page, 'Search box UI')
  await done.hover()
  const reopen = done.getByTestId('topic-reopen')
  await expect(reopen).toHaveAttribute('title', 'Reopen (1)')
  await reopen.click()
  await expect(pane(page).getByTestId('thread-tasks-in_progress')).toContainText('Search box UI')
  await expect(pane(page).getByTestId('topic-pane')).toHaveCount(0)
  await expect.poll(() => status(page, minbox, search, 'Search box UI')).toBe('in_progress')
})

test.describe('phone check button', () => {
  test.use({ hasTouch: true })

  test('phone: the check button shows without hover in the full-screen tasks and marks the task done', async ({ page, minbox }) => {
    const { sid, search } = await seed(page, minbox)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${minbox.url}/#s=${sid}&t=${search}`)
    await page.getByTestId('tasks-toggle').click()
    const ui = card(page, 'Index format')
    await expect(ui).toBeVisible(SLOW)
    const btn = ui.getByTestId('topic-done')
    await expect(btn).toBeVisible()
    await btn.tap()
    await expect(pane(page).getByTestId('thread-tasks-done')).toContainText('Index format')
    await expect(pane(page).getByTestId('topic-pane')).toHaveCount(0)
    await expect.poll(() => status(page, minbox, search, 'Index format')).toBe('done')
    await card(page, 'Index format').getByTestId('topic-reopen').tap()
    await expect(pane(page).getByTestId('thread-tasks-in_progress')).toContainText('Index format')
    await expect.poll(() => status(page, minbox, search, 'Index format')).toBe('in_progress')
  })
})

test('desktop: a thread without tasks — the pane says the agent adds them', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  const { sid, empty } = await seed(page, minbox)
  await page.goto(`${minbox.url}/#s=${sid}&t=${empty}`)
  await page.getByTestId('tasks-toggle').click()
  await expect(pane(page).getByTestId('thread-tasks-empty')).toContainText('the agent adds them')
  await expect(pane(page).getByTestId('topic-card')).toHaveCount(0)
})

test('phone: the header button opens the thread’s tasks full screen, with Back', async ({ page, minbox }) => {
  const { sid, search } = await seed(page, minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${minbox.url}/#s=${sid}&t=${search}`)
  await expect(page.getByTestId('phone')).toBeVisible()
  await expect(page.getByTestId('phone-thread-subject')).toHaveText('Search for the inbox')
  await page.getByTestId('tasks-toggle').click()
  const full = page.getByTestId('phone-tasks')
  await expect(full).toBeVisible()
  await expect(card(page, 'Search box UI')).toBeVisible(SLOW)
  await expect(card(page, 'Index format')).toBeVisible()
  // Full screen: it covers the thread.
  const b = (await full.boundingBox())!
  expect(b.width).toBeGreaterThanOrEqual(389)
  expect(b.height).toBeGreaterThan(800)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/thread-tasks-phone.png` })

  // A task full screen; its Back returns to the list; a related message closes it and shows the message.
  await card(page, 'Search box UI').click()
  await expect(page.getByTestId('topic-pane-title')).toHaveText('Search box UI')
  await page.getByTestId('topic-pane-back').click()
  await expect(card(page, 'Index format')).toBeVisible()
  // Its message box sends from full screen too; the message is in the thread behind.
  await card(page, 'Search box UI').click()
  await page.getByTestId('topic-pane-input').fill('Phone note on search.')
  await page.getByTestId('topic-pane-send').click()
  await expect(page.getByTestId('topic-pane-input')).toHaveValue('')
  await expect
    .poll(async () => {
      const th: { messages: { author: string; words?: string; delivery?: string }[] } = await (await page.request.get(`${minbox.url}/api/threads/${search}`)).json()
      const m = th.messages.find((x) => x.author === 'user' && (x.words ?? '').endsWith('\n\nPhone note on search.'))
      return m && m.words!.startsWith('[Task: Search box UI]\n> Task context (from minbox): ') ? m.delivery : undefined
    }, SLOW)
    .toBe('delivered')
  await page.getByTestId('topic-message').first().click()
  await expect(full).toHaveCount(0)
  await expect(page.locator('[data-testid="message"]').filter({ hasText: 'Phone note on search.' }).getByTestId('task-context-title')).toHaveText('Search box UI')
  await expect(page.locator('[data-testid="message"][data-jumped="true"]')).toContainText('Add search to the inbox.')

  // Back closes the full-screen tasks.
  await page.getByTestId('tasks-toggle').click()
  await expect(full).toBeVisible()
  await page.getByTestId('tasks-back').click()
  await expect(full).toHaveCount(0)
  await expect(page.getByTestId('phone-thread-subject')).toHaveText('Search for the inbox')
})

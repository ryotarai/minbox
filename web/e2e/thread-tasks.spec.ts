import type { Page } from '@playwright/test'
import { createSession, expect, test, type Minbox } from './fixtures'

// A thread's Tasks pane: the open thread's tasks (topics in the API) beside the thread on a desktop,
// between the thread and the agent terminal when that is open; full screen on a phone. The fake
// helper (fake-suggest.py) takes every "TOPIC: <title> | <status> | <summary>" line as a task.
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

  // Selecting a task: its detail in the pane (no thread link, no message box), Back to the list.
  await card(page, 'Search box UI').click()
  const detail = pane(page).getByTestId('topic-pane')
  await expect(detail).toBeVisible()
  await expect(detail.getByTestId('topic-pane-title')).toHaveText('Search box UI')
  await expect(detail.getByTestId('topic-pane-progress')).toHaveText('1/2 done')
  await expect(detail.getByTestId('topic-pane-detail').locator('strong')).toHaveText('search field')
  await expect(detail.getByTestId('topic-pane-thread')).toHaveCount(0)
  await expect(detail.getByTestId('topic-pane-compose')).toHaveCount(0)

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
  await expect(pane(page).getByTestId('thread-tasks-empty')).toHaveText('No tasks yet — they appear after the next message.')

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

test('desktop: tasks turned off — the pane says so', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1500, height: 900 })
  await fetch(minbox.url + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: minbox.url },
    body: JSON.stringify({ topics: false }),
  })
  const { sid, empty } = await seed(page, minbox)
  await page.goto(`${minbox.url}/#s=${sid}&t=${empty}`)
  await page.getByTestId('tasks-toggle').click()
  await expect(pane(page).getByTestId('thread-tasks-off')).toContainText('Tasks are turned off')
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
  await card(page, 'Search box UI').click()
  await page.getByTestId('topic-message').first().click()
  await expect(full).toHaveCount(0)
  await expect(page.locator('[data-testid="message"][data-jumped="true"]')).toContainText('Add search to the inbox.')

  // Back closes the full-screen tasks.
  await page.getByTestId('tasks-toggle').click()
  await expect(full).toBeVisible()
  await page.getByTestId('tasks-back').click()
  await expect(full).toHaveCount(0)
  await expect(page.getByTestId('phone-thread-subject')).toHaveText('Search for the inbox')
})

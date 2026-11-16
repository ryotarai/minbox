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
    'Add search to the inbox.\nTOPIC: Search box UI | in_progress | Building the search field and results list\nTOPIC: Index format | waiting_on_you | Pick SQLite FTS5 or plain LIKE before indexing',
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

  // A card opens its thread.
  await card(page, 'in_progress', 'Search box UI').click()
  await expect(page.getByTestId('topics')).toHaveCount(0)
  await expect(page.getByTestId('thread-subject')).toHaveText('Search for the inbox')

  // The old Board address opens Topics.
  await page.goto(minbox.url + '/#v=board')
  await expect(page.getByTestId('topics')).toBeVisible()
})

test('phone: the columns are tabs; a card opens its thread', async ({ page, minbox }) => {
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

  await card(page, 'done', 'Release notes v1.4').click()
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

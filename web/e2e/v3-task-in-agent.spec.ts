// The task page is gone: a task opens in its agent's page, selected there (#s=<agent>&v=agent&k=<task>),
// as a card (title, where it stands, status, agents, and its checklist beside them) above its messages.
// Old #v=task&k=… links (bookmarks, notifications already sent) are replaced with that page; a task no
// agent has touched opens in its project's most recently active live agent, and with no agent at all on the Board, its row
// focused. The agent's header has no status line under the name, and the card has no ✕ or Open.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import type { Page } from '@playwright/test'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

/** CARD_SHOTS=<dir>: screenshots of the task card (for review). */
async function shot(page: Page, name: string) {
  const dir = process.env.CARD_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

test('an old #v=task link is replaced with the agent page, the task selected (and the message highlighted)', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  const reply = await agentReply(minbox, a, /created a task/)
  await page.goto('about:blank')
  await page.goto(`${minbox.url}/#v=task&k=${t.id}&m=${reply.id}`)
  await expect(page).toHaveURL(new RegExp(`#s=${a.id}&v=agent&k=${t.id}&m=${reply.id}$`))
  const len = await page.evaluate(() => history.length)
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-detail', t.id)
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(page.locator(`[data-testid="tasks-pane"] [data-testid="agent-task"][data-task="${t.id}"]`)).toHaveAttribute('aria-current', 'true')
  await expect(page.locator(`[data-testid="v3-message"][data-message-id="${reply.id}"]`)).toHaveClass(/\bhl\b/)
  // Replaced, not pushed: the browser's back leaves the app.
  expect(await page.evaluate(() => history.length)).toBe(len)
  await page.goBack()
  await expect.poll(() => page.url()).toBe('about:blank')
})

test("the task card: its checklist with progress n/m beside the title (below it on a phone); no ✕, no Open, no status line under the agent's name", async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${minbox.url}/#s=${a.id}&v=agent&k=${t.id}`)
  const card = page.getByTestId('task-card')
  const check = card.getByTestId('task-checklist')
  // No heading: the progress bar (segments, n/m) is the first row, level with the title; the steps below.
  await expect(check).not.toContainText('CHECKLIST')
  await expect(check.getByTestId('step')).toHaveCount(4)
  const progress = check.getByTestId('task-checklist-progress')
  await expect(progress.getByTestId('progress').locator('i')).toHaveCount(4)
  await expect(progress).toHaveText('0/4')
  const pb = (await progress.boundingBox())!
  const tb = (await card.getByTestId('task-title').boundingBox())!
  expect(Math.abs(pb.y + pb.height / 2 - (tb.y + tb.height / 2))).toBeLessThan(6)
  expect((await check.getByTestId('step').first().boundingBox())!.y).toBeGreaterThan(pb.y + pb.height - 1)
  await expect(check.locator('.v-st.doing .v-now')).toHaveText('now')
  // A right column beside the title, status and agents.
  const title = (await card.getByTestId('task-title').boundingBox())!
  const list = (await check.boundingBox())!
  expect(list.x).toBeGreaterThan(title.x + title.width - 1)
  expect(list.y).toBeLessThan(title.y + title.height)
  await expect(card.getByTestId('task-status')).toHaveValue('working')
  await expect(card.getByTestId('task-agent')).toContainText('api')
  await shot(page, 'card-desktop')

  // A click ticks a step.
  await check.getByTestId('step').first().click()
  await expect(check).toContainText('1/4')
  await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)).task.steps[0].done).toBe(true)

  // Gone: the card's ✕ and Open, and the line under the agent's name ("idle · … · on <task>").
  await expect(page.getByTestId('task-detail-close')).toHaveCount(0)
  await expect(page.getByTestId('column-open')).toHaveCount(0)
  await expect(page.getByTestId('now-on')).toHaveCount(0)
  await expect(page.getByTestId('stream-view').locator('> .v-head .v-r2')).toHaveCount(0)
  await expect(page.getByTestId('agent-state')).toHaveAttribute('data-state', 'idle')

  // Narrow (a phone): the checklist below the title.
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-layout', 'phone')
  const t2 = (await card.getByTestId('task-title').boundingBox())!
  const l2 = (await check.boundingBox())!
  expect(l2.y).toBeGreaterThan(t2.y + t2.height - 1)
  await shot(page, 'card-phone')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
})

test('a long checklist stays a short box until Show all', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const steps = Array.from({ length: 9 }, (_, i) => ({ text: `Step number ${i + 1}`, done: i < 6 }))
  const t = await api(minbox, 'POST', '/api/v3/tasks', { title: 'A long one', session_id: a.id })
  await api(minbox, 'PATCH', `/api/v3/tasks/${t.id}`, { steps })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`${minbox.url}/#s=${a.id}&v=agent&k=${t.id}`)
  const check = page.getByTestId('task-checklist')
  await expect(check).toContainText('6/9')
  const box = check.getByTestId('task-checklist-list')
  const folded = (await box.boundingBox())!.height
  expect(folded).toBeLessThan(130)
  // Scrolled to the current step.
  await expect(check.locator('.v-st.doing')).toBeInViewport()
  await check.getByTestId('task-checklist-more').click()
  await expect(check.getByTestId('task-checklist-more')).toHaveText('Show less')
  expect((await box.boundingBox())!.height).toBeGreaterThan(folded + 40)
})

test('a task no agent has touched opens in its project\'s most recently active agent; with no agent at all, the Board with its row focused', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  // a, started first, is the one active last.
  await say(minbox, a, 'hello there')
  const at = (s: any) => new Date(s.last_activity ?? s.updated_at).getTime()
  await expect
    .poll(async () => {
      const ss = await api(minbox, 'GET', '/api/sessions')
      return at(ss.find((s: any) => s.id === a.id)) > at(ss.find((s: any) => s.id === b.id))
    })
    .toBe(true)
  const loose = await api(minbox, 'POST', '/api/v3/tasks', { project_id: a.project_id, title: 'Nobody has this yet' })
  await page.goto(`${minbox.url}/#v=task&k=${loose.id}`)
  await expect(page).toHaveURL(new RegExp(`#s=${a.id}&v=agent&k=${loose.id}`))
  await expect(page.getByTestId('task-title')).toHaveText('Nobody has this yet')

  // A project without agents.
  const dir = join(minbox.dataDir, 'empty')
  mkdirSync(dir, { recursive: true })
  const p = await api(minbox, 'POST', '/api/projects', { dir, name: 'empty' })
  const orphan = await api(minbox, 'POST', '/api/v3/tasks', { project_id: p.id, title: 'An orphan task' })
  await page.goto(`${minbox.url}/#v=task&k=${orphan.id}`)
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-view', 'board')
  expect(new URL(page.url()).hash).toBe('')
  await expect(page.locator(`[data-key="t:${orphan.id}"]`)).toHaveClass(/\bfocus\b/)
})

// The agent's stream shows its tasks' status changes between the messages, in time order: a new
// task, the agent's update_task to needs you, the person's done, the agent's reopening (a message of
// the person about the done task leaves it done).
// Each line's title opens the task. Step ticks get no line; the task view gets no status lines.
import type { Locator } from '@playwright/test'
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

/** The stream's messages and task lines, in the order shown. */
async function order(stream: Locator): Promise<string[]> {
  return stream.locator('[data-testid="v3-message"], [data-testid="stream-event"]').evaluateAll((els) =>
    els.map((e) => {
      const el = e as HTMLElement
      if (el.dataset.testid === 'stream-event') return `ev:${el.dataset.kind}:${el.dataset.status ?? ''}`
      return `${el.dataset.author}:${(el.querySelector('.v-bd .md')?.textContent ?? el.textContent ?? '').trim().slice(0, 16).trim()}`
    }),
  )
}

test('agent stream: task status changes as lines between the messages, live, opening the task', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  // The agent's update_task with a status (the fake claude's NEEDYOU).
  await say(minbox, a, 'NEEDYOU about the gauge')
  await agentReply(minbox, a, /I need you to look at the gauge/)

  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const stream = page.getByTestId('stream-view')
  await expect(stream.getByTestId('v3-message')).toHaveCount(4)
  await expect(stream.locator(`[data-testid="stream-event"][data-task="${gauge.id}"]`)).toHaveCount(2)
  await expect(stream.locator('[data-testid="stream-event"][data-kind="created"]')).toContainText('New task: Fix the gauge reading')
  await expect(stream.locator('[data-testid="stream-event"][data-status="needs_you"]')).toContainText(/Fix the gauge reading → needs you/)
  expect(await order(stream)).toEqual([
    'user:please fix the g',
    'ev:created:',
    'agent:On it. I created',
    'user:NEEDYOU about th',
    'ev:status:needs_you',
    'agent:I need you to lo',
  ])

  // Live: the person marks it done (the Board's check); a message about it leaves it done.
  await api(minbox, 'PATCH', `/api/v3/tasks/${gauge.id}`, { status: 'done' })
  const done = stream.locator('[data-testid="stream-event"][data-status="done"]')
  await expect(done).toContainText(/→ done · by you/)
  await say(minbox, a, 'one more thing about the gauge', [gauge.id])
  await agentReply(minbox, a, /Noted for/)
  await expect(stream.getByTestId('v3-message')).toHaveCount(6)
  expect((await order(stream)).slice(6)).toEqual(['ev:status:done', 'user:one more thing a', 'agent:Noted for “Fix t'])
  expect((await api(minbox, 'GET', `/api/v3/tasks/${gauge.id}`)).task.status).toBe('done')
  // The agent decides there is more work and reopens it (update_task status working).
  await say(minbox, a, 'REOPEN the gauge, it drifts again', [gauge.id])
  await agentReply(minbox, a, /Reopened “Fix the gauge reading”/)
  const reopened = stream.locator('[data-testid="stream-event"][data-status="working"]')
  await expect(reopened).toContainText(/Fix the gauge reading reopened/)
  await expect(reopened).not.toContainText('by you')
  await expect(stream.getByTestId('v3-message')).toHaveCount(8)
  expect((await order(stream)).slice(9)).toEqual(['user:REOPEN the gauge', 'ev:status:working', 'agent:Reopened “Fix th'])

  // A step tick is no line.
  const t = await api(minbox, 'GET', `/api/v3/tasks/${gauge.id}`)
  await api(minbox, 'PATCH', `/api/v3/tasks/${gauge.id}`, { steps: t.task.steps.map((s: any, i: number) => ({ ...s, done: i === 0 })) })
  await page.waitForTimeout(600)
  await expect(stream.getByTestId('stream-event')).toHaveCount(4)

  // The title opens the task; its view has no status lines.
  await done.getByTestId('stream-event-task').click()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(page.getByTestId('event').filter({ hasText: /→/ })).toHaveCount(0)
})

test("a done task's view: the person's message goes in the task, and the task stays Done", async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await api(minbox, 'PATCH', `/api/v3/tasks/${gauge.id}`, { status: 'done' })

  await page.goto(`${minbox.url}/#v=task&k=${gauge.id}`)
  await expect(page.getByTestId('task-status')).toHaveValue('done')
  const box = page.getByTestId('task-composer')
  await box.getByTestId('composer-text').fill('thanks, the gauge looks right now')
  await box.getByTestId('composer-send').click()
  await expect(box.getByTestId('composer-text')).toHaveValue('')
  await agentReply(minbox, a, /Noted for “Fix the gauge reading”/)
  const t = await api(minbox, 'GET', `/api/v3/tasks/${gauge.id}`)
  expect(t.task.status).toBe('done')
  expect(t.messages.some((m: any) => m.author === 'user' && /looks right now/.test(m.body))).toBe(true)
  await page.waitForTimeout(400)
  await expect(page.getByTestId('task-status')).toHaveValue('done')
})

test('agent stream: "show earlier" brings the task lines of the earlier messages', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'NEEDYOU about the gauge')
  await agentReply(minbox, a, /I need you to look at the gauge/)
  // Each page (by message) owns the lines up to its last message: none twice, none lost.
  const all = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  const newest = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream?limit=2`)
  const earlier = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream?limit=2&before=${newest.messages[0].id}`)
  const ids = (s: any) => s.task_events.map((e: any) => e.id)
  expect(ids(all)).toHaveLength(2)
  expect([...ids(earlier), ...ids(newest)]).toEqual(ids(all))
  expect(earlier.task_events[0].kind).toBe('created')
  expect(newest.task_events[0].status).toBe('needs_you')
  expect(all.task_events.every((e: any) => e.task_id === gauge.id)).toBe(true)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('stream-view').getByTestId('stream-event')).toHaveCount(2)
  // A rename is a line too, live: old → new.
  await api(minbox, 'PATCH', `/api/v3/tasks/${gauge.id}`, { title: 'Gauge fix' })
  await expect(page.locator('[data-testid="stream-event"][data-kind="title"]')).toHaveText(/Renamed “Fix the gauge reading” → Gauge fix · by you/)
})

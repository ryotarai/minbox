// UC4 (follow up on existing work), UC5 (context around tagged messages), UC9 (hand work to another
// agent): the task view answers "where is this work?" and its reply goes to the right agent, tagged.
import { test, expect } from './fixtures'
import { agentReply, api, say, shot, startAgent, taskNamed } from './v3'

test('task view: its messages, show context, reply to the last agent about the task, hand off to another agent', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'is the staging server up?')
  await agentReply(minbox, a, /Sure — noted/)
  await say(minbox, a, 'the gauge reading is off by one')
  await agentReply(minbox, a, /adding this to/)

  await page.goto(minbox.url)
  await page.locator(`[data-testid="task-row"][data-task="${gauge.id}"] .v-line`).dblclick()
  const view = page.getByTestId('task-view')
  await expect(view.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  // 4 messages about it (2 asks, 2 replies); the chat between them is folded into a gap.
  await expect(view.getByTestId('v3-message')).toHaveCount(4)
  const gap = view.getByTestId('show-context')
  await expect(gap).toContainText('api · 2 other messages')
  await gap.click()
  await expect(view.locator('.v-msg.ctx')).toHaveCount(2)
  await expect(view.locator('.v-msg.ctx').first()).toContainText('is the staging server up?')
  await shot(page, 'uc4-task', 'light')

  // R focuses the reply; ⌘↵ sends it to the last agent, tagged with the task.
  await page.keyboard.press('r')
  await expect(page.getByTestId('composer-to')).toHaveValue(a.id)
  await page.keyboard.type('what is left on this?')
  await page.keyboard.press('ControlOrMeta+Enter')
  const reply = await agentReply(minbox, a, /Noted for “Fix the gauge reading”/)
  expect(reply.tasks.map((t: any) => t.task_id)).toEqual([gauge.id])
  await expect(view.getByTestId('v3-message').filter({ hasText: 'Noted for' })).toBeVisible()

  // Hand off: a second agent; the message goes there with the task's tag, the task gains the agent.
  const b = await startAgent(minbox, 'worker')
  await page.getByTestId('composer-to').selectOption(b.id)
  await page.getByTestId('composer-text').fill('please take over the tests for this')
  await page.getByTestId('composer-send').click()
  await agentReply(minbox, b, /Noted for “Fix the gauge reading”/)
  await expect(view.getByTestId('event').filter({ hasText: 'Handed to worker by you' })).toBeVisible()
  const t = await api(minbox, 'GET', `/api/v3/tasks/${gauge.id}`)
  expect(t.task.agents.map((x: any) => x.session_id).sort()).toEqual([a.id, b.id].sort())
  // The default recipient follows the most recent agent.
  await page.reload()
  await expect(page.getByTestId('composer-to')).toHaveValue(b.id)
})

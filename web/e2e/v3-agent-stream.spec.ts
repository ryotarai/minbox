// UC6 (see what one agent is doing / open its terminal): the agent's stream with task chips, + tag to
// tag any message, the agent's tasks beside it, and its terminal one key away. Older threads read as
// segments of the stream (divider with their subject).
import { test, expect } from './fixtures'
import { agentReply, api, say, shot, startAgent, taskNamed } from './v3'

test('agent stream: chips, + tag picker with a new task, the terminal beside the stream', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'is the staging server up?')
  await agentReply(minbox, a, /Sure — noted/)

  await page.goto(minbox.url)
  await page.getByTestId('agent-row').filter({ hasText: 'api' }).click()
  const stream = page.getByTestId('stream-view')
  await expect(stream.getByTestId('agent-name')).toHaveText('api')
  await expect(stream.getByTestId('v3-message')).toHaveCount(4)
  // The agent's tasks are beside the stream.
  await expect(page.getByTestId('agent-side')).toContainText('Fix the gauge reading')
  await shot(page, 'uc6-stream', 'dark')

  // + tag on the untagged question: a new task named in the picker.
  const q = stream.locator('[data-testid="v3-message"]').filter({ hasText: 'is the staging server up?' })
  await q.getByTestId('tag-add').click()
  await page.keyboard.type('Staging health')
  await expect(page.getByTestId('tag-new')).toContainText('New task “Staging health”')
  await page.keyboard.press('Enter')
  await expect(q.getByTestId('tag')).toHaveAttribute('title', 'Staging health')
  await taskNamed(minbox, 'Staging health')

  // T opens the terminal beside the stream (the fake agent's screen).
  await page.locator('body').click({ position: { x: 700, y: 30 } })
  await page.keyboard.press('t')
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(page.getByTestId('pane-terminal')).toHaveClass(/on/)
  await shot(page, 'uc6-terminal', 'light')
  await page.getByTestId('pane-tasks').click()
  await expect(page.getByTestId('terminal')).toHaveCount(0)

  // A chip opens its task.
  await stream.locator('[data-testid="tag"][title="Staging health"]').first().click()
  await expect(page.getByTestId('task-title')).toHaveText('Staging health')
})

test('older threads are segments of the stream, with a divider', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  // An older-style thread (as every thread was before v3): the person's message to it via the old reply API.
  const th = await api(minbox, 'POST', `/api/sessions/${a.id}/threads`, { subject: 'Old deploy plan', body: 'ship it friday' })
  await expect.poll(async () => (await api(minbox, 'GET', `/api/threads/${th.id}`)).messages[0].delivery).toBe('delivered')
  await say(minbox, a, 'is the staging server up?')
  await agentReply(minbox, a, /Sure — noted/)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const stream = page.getByTestId('stream-view')
  await expect(stream.getByTestId('segment-divider')).toHaveText('— Old deploy plan —')
  await expect(stream.getByTestId('v3-message')).toHaveCount(3)
})

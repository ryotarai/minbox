// UC6 (see what one agent is doing / open its terminal): the agent's stream with the task each message
// is about, ⋯ → Put in a task…, the agent's open tasks beside it, and its terminal one key away. Older
// threads read as segments of the stream (divider with their subject).
import { test, expect } from './fixtures'
import { agentReply, api, say, shot, startAgent, taskAbove, taskNamed } from './v3'

test('agent stream: task links, put a message in a new task, the terminal beside the stream', async ({ page, minbox }) => {
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

  // The header says what it is on now (one task), not a wall of every task.
  await expect(stream.getByTestId('now-on')).toContainText('Fix the gauge reading')
  // ⋯ → Put in a task… on the question about no task: a new task named in the picker.
  const q = stream.locator('[data-testid="v3-message"]').filter({ hasText: 'is the staging server up?' })
  await q.hover()
  await q.getByTestId('msg-menu').click()
  await page.getByTestId('menu-move').click()
  await page.keyboard.type('Staging health')
  await expect(page.getByTestId('task-new')).toContainText('New task “Staging health”')
  await page.keyboard.press('Enter')
  await expect(taskAbove(q)).toHaveAttribute('title', 'Staging health')
  await taskNamed(minbox, 'Staging health')

  // # at the start of the reply box says which task the message being written is about.
  await page.getByTestId('composer-text').click()
  await page.keyboard.type('#')
  await expect(page.getByTestId('task-picker')).toBeVisible()
  await page.keyboard.type('staging')
  // The new task reaches the picker with the Board's next refresh.
  await expect(page.getByTestId('task-option').filter({ hasText: 'Staging health' })).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('composer').getByTestId('task-link')).toHaveAttribute('title', 'Staging health')
  await page.getByTestId('composer-text').fill('the staging check is green now')
  await page.getByTestId('composer-send').click()
  const sent = stream.locator('[data-testid="v3-message"][data-author="user"]').filter({ hasText: 'the staging check is green now' })
  await expect(taskAbove(sent)).toHaveAttribute('title', 'Staging health')
  await expect(sent).not.toHaveClass(/pending/)

  // T opens the terminal beside the stream (the fake agent's screen).
  await page.locator('body').click({ position: { x: 700, y: 30 } })
  await page.keyboard.press('t')
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(page.getByTestId('pane-terminal')).toHaveClass(/on/)
  await shot(page, 'uc6-terminal', 'light')
  await page.getByTestId('pane-tasks').click()
  await expect(page.getByTestId('terminal')).toHaveCount(0)

  // A task link opens its task.
  await stream.locator('[data-testid="task-link"][title="Staging health"] button').first().click()
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

test('the task is named once above each run of messages in it, again when the task changes', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'is the staging server up?')
  await agentReply(minbox, a, /Sure — noted/)
  await say(minbox, a, 'one more thing: the needle wobbles at zero', [gauge.id])
  await agentReply(minbox, a, /Noted for/)

  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const stream = page.getByTestId('stream-view')
  const msgs = stream.getByTestId('v3-message')
  await expect(msgs).toHaveCount(6)
  // Three runs: gauge (ask + reply), staging (ask + reply), gauge again (ask + reply).
  const topics = stream.getByTestId('task-topic')
  await expect(topics).toHaveCount(3)
  await expect(topics.nth(0).getByTestId('task-link')).toHaveAttribute('title', gauge.title)
  await expect(topics.nth(1).getByTestId('task-link')).toHaveAttribute('title', 'Is the staging server up')
  await expect(topics.nth(2).getByTestId('task-link')).toHaveAttribute('title', gauge.title)
  // Each message is under the topic line of its own task, and its header does not repeat it.
  for (let i = 0; i < 6; i++) {
    const m = msgs.nth(i)
    const t = await m.getAttribute('data-task')
    expect(t).toBeTruthy()
    await expect(m.locator('xpath=preceding-sibling::*[@data-testid="task-topic"][1]')).toHaveAttribute('data-task', t!)
    await expect(m.getByTestId('task-link')).toHaveCount(0)
  }
  // The new task the agent made is said in its reply's header.
  await expect(msgs.nth(1).getByTestId('decision')).toHaveText('→ new task')
  // The topic line opens its task.
  await topics.nth(1).getByTestId('task-link').locator('button').click()
  await expect(page.getByTestId('task-title')).toHaveText('Is the staging server up')
  // In the task view every message is of that task: no topic lines, no task in the headers.
  const view = page.getByTestId('v3-message')
  await expect(view).toHaveCount(2)
  await expect(page.getByTestId('task-topic')).toHaveCount(0)
  await expect(view.getByTestId('task-link')).toHaveCount(0)
})

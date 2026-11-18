// UC6 (see what one agent is doing / open its terminal): the agent's stream with the task each message
// is about, ⋯ → Put in a task…, the agent's open tasks beside it, and its terminal one key away. Older
// threads read as segments of the stream (divider with their subject).
import { test, expect } from './fixtures'
import { agentReply, api, say, shot, startAgent, taskOn, taskNamed } from './v3'

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
  // The agent's tasks are in their pane, between the agents list and the stream.
  await expect(page.getByTestId('tasks-pane')).toContainText('Fix the gauge reading')
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
  await shot(page, 'uc6-stream', 'dark')

  // The header is the agent's name, kind and buttons: no status line under it (no "idle · … · on <task>").
  await expect(stream.getByTestId('agent-state')).toHaveAttribute('data-state', 'idle')
  await expect(stream.getByTestId('now-on')).toHaveCount(0)
  await expect(stream.locator('.v-head .v-r2')).toHaveCount(0)
  // ⋯ → Put in a task… on the question about no task: a new task named in the picker.
  const q = stream.locator('[data-testid="v3-message"]').filter({ hasText: 'is the staging server up?' })
  await q.hover()
  await q.getByTestId('msg-menu').click()
  await page.getByTestId('menu-move').click()
  await page.keyboard.type('Staging health')
  await expect(page.getByTestId('task-new')).toContainText('New task “Staging health”')
  await page.keyboard.press('Enter')
  await expect(taskOn(q)).toHaveAttribute('title', 'Staging health')
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
  await expect(taskOn(sent)).toHaveAttribute('title', 'Staging health')
  await expect(sent).not.toHaveClass(/pending/)

  // T opens the terminal beside the stream (the fake agent's screen).
  await page.locator('body').click({ position: { x: 700, y: 30 } })
  await page.keyboard.press('t')
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'true')
  await shot(page, 'uc6-terminal', 'light')
  await page.getByTestId('terminal-close').click()
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)

  // A task link opens its task: in the agent's page, selected.
  await stream.locator('[data-testid="task-link"][title="Staging health"] button').first().click()
  await expect(page.getByTestId('task-title')).toHaveText('Staging health')
  await expect(page).toHaveURL(new RegExp(`s=${a.id}.*v=agent.*k=`))
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

test('every message shows its task as a badge in its box, quieter (no fill) when the one before is in the same task', async ({ page, minbox }) => {
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
  // gauge (ask + reply), staging (ask + reply), gauge again (ask + reply): a badge in every box, the
  // second of each pair (same task as the one before) without the pill's fill; its text never fades.
  const titles = [gauge.title, gauge.title, 'Is the staging server up', 'Is the staging server up', gauge.title, gauge.title]
  for (let i = 0; i < 6; i++) {
    const m = msgs.nth(i)
    await expect(m.locator('.v-bd').getByTestId('task-badge')).toHaveCount(1)
    await expect(taskOn(m)).toHaveAttribute('title', titles[i]!)
    await expect(m.getByTestId('task-badge')).toHaveAttribute('data-task', (await m.getAttribute('data-task'))!)
    if (i % 2) await expect(m).toHaveClass(/\brep\b/)
    else await expect(m).not.toHaveClass(/\brep\b/)
    await expect(m.getByTestId('task-badge')).toHaveCSS('opacity', '1')
  }
  // The repeated badge has no fill; the first of a run has one.
  await expect(msgs.nth(1).getByTestId('task-badge')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(msgs.nth(0).getByTestId('task-badge')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(stream.getByTestId('task-topic')).toHaveCount(0)
  // The new task the agent made: a small suffix beside the badge.
  await expect(msgs.nth(1).getByTestId('decision')).toHaveText('→ new task')
  // ⋮ sits beside the badge.
  await msgs.nth(2).hover()
  await msgs.nth(2).getByTestId('about').getByTestId('msg-menu').click()
  await expect(page.getByTestId('menu-move')).toHaveText('Move to another task…')
  await msgs.nth(2).getByTestId('msg-menu').click()
  await expect(page.getByTestId('menu-move')).toHaveCount(0)
  // A badge opens its task.
  await taskOn(msgs.nth(2)).locator('button').click()
  await expect(page.getByTestId('task-title')).toHaveText('Is the staging server up')
  // In the task view every message is of that task: no badges, the ⋮ in the header.
  const view = page.getByTestId('v3-message')
  await expect(view).toHaveCount(2)
  await expect(view.getByTestId('task-badge')).toHaveCount(0)
  await expect(view.first().locator('.v-w').getByTestId('msg-menu')).toHaveCount(1)
})

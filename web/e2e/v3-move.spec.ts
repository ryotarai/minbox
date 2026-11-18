// UC7 (move a message to the right task): under a reply the agent filed under a mistaken new task,
// ⋯ → Move to another task… moves the reply and the person's message together, and the mistaken task
// goes; "Put in a task…" on a reply the agent has not placed yet. A message is always about a task:
// there is no "Not about a task".
import { test, expect } from './fixtures'
import { agentReply, board, say, shot, startAgent, taskNamed } from './v3'

test('move both messages to the right task and remove the mistaken one; put in a task; never about no task', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  // The agent wrongly makes a new task for what is really the gauge work.
  await say(minbox, a, 'please update the needle color')
  await taskNamed(minbox, /Update the needle color/)
  const wrong = await agentReply(minbox, a, /Update the needle color/)

  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const stream = page.getByTestId('stream-view')
  const reply = stream.locator(`[data-testid="v3-message"][data-message-id="${wrong.id}"]`)
  await expect(reply.locator('[data-testid="decision"][data-decision="created"]')).toContainText('Update the needle color')
  await reply.hover()
  await reply.getByTestId('msg-menu').click()
  await page.getByTestId('menu-move').click()
  const picker = page.getByTestId('task-picker')
  await expect(picker).toContainText('Move this reply and your message to')
  await page.keyboard.type('gauge')
  await shot(page, 'uc7-move', 'dark')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Removed the mistaken task “Update the needle color”')).toBeVisible()
  await expect(reply.locator('[data-testid="decision"][data-decision="moved"]')).toBeVisible()
  await expect.poll(async () => (await board(minbox)).tasks.map((t: any) => t.title)).toEqual(['Fix the gauge reading'])
  const t = (await board(minbox)).tasks[0]
  expect(t.id).toBe(gauge.id)
  expect(t.message_count).toBe(4)

  // Put in a task… on a reply the agent has not placed yet: it and the person's message.
  await say(minbox, a, 'IGNORE is the staging server up?')
  const chat = await agentReply(minbox, a, /Sure — noted/)
  const none = stream.locator(`[data-testid="v3-message"][data-message-id="${chat.id}"]`)
  await expect(none.getByTestId('unplaced')).toContainText('waiting for api to place it')
  await none.hover()
  await none.getByTestId('msg-menu').click()
  await page.getByTestId('menu-move').click()
  await page.keyboard.type('gauge')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await board(minbox)).tasks[0].message_count).toBe(6)

  await expect(none.getByTestId('unplaced')).toHaveCount(0)

  // No "Not about a task": a message only moves to another task.
  const last = stream.locator('[data-testid="v3-message"][data-author="user"]').last()
  await last.hover()
  await last.getByTestId('msg-menu').click()
  await expect(page.getByTestId('menu-move')).toHaveText('Move to another task…')
  await expect(page.getByTestId('menu-none')).toHaveCount(0)
})

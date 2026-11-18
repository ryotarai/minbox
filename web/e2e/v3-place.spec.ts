// Every message is about a task. A turn that leaves messages in no task ends with minbox asking the
// agent to place them; it asks again after each turn that leaves them, until the agent does. Until
// then the message says it waits for the agent.
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent } from './v3'

test('the agent ignores the request to place its messages, is asked again after each turn, and places them', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const stream = page.getByTestId('stream-view')
  await say(minbox, a, 'IGNORE how is it going?')
  const chat = await agentReply(minbox, a, /Sure — noted/)
  const reply = stream.locator(`[data-testid="v3-message"][data-message-id="${chat.id}"]`)
  await expect(reply.getByTestId('unplaced')).toContainText('waiting for api to place it')
  // Asked three times (the first two ignored); the third time it puts them in a task.
  const asks = stream.locator('[data-testid="v3-message"][data-kind="place"]')
  await expect(asks).toHaveCount(3, { timeout: 20_000 })
  await expect(asks.first()).toContainText('Asked api to put 2 messages in tasks')
  await expect(reply.getByTestId('unplaced')).toHaveCount(0, { timeout: 10_000 })
  await expect(reply.getByTestId('task-link')).toHaveAttribute('title', 'Quick questions')
  await expect(stream.getByTestId('unplaced')).toHaveCount(0)
  // Nothing is left in no task, and no more requests come.
  await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)).messages.filter((m: any) => m.tasks.length === 0).length).toBe(0)
  await page.waitForTimeout(3000)
  await expect(asks).toHaveCount(3)
})

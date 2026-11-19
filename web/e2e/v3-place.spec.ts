// Every message is about a task, and the agent places them itself. A reply it left in no task says it
// waits for the agent; minbox does not ask the agent after the turn to place it (no request, no note).
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent } from './v3'

test('a reply left in no task: minbox does not ask the agent to place it', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const stream = page.getByTestId('stream-view')
  await say(minbox, a, 'IGNORE how is it going?')
  const chat = await agentReply(minbox, a, /Sure — noted/)
  const reply = stream.locator(`[data-testid="v3-message"][data-message-id="${chat.id}"]`)
  await expect(reply.getByTestId('unplaced')).toContainText('waiting for api to place it')
  // Well after the turn: no request to place it, in the stream or in the data.
  await page.waitForTimeout(3000)
  await expect(stream.locator('[data-testid="v3-message"][data-kind="place"]')).toHaveCount(0)
  await expect(stream.getByText(/to put \d+ messages? in tasks/)).toHaveCount(0)
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  expect(s.messages.filter((m: any) => m.kind === 'place')).toHaveLength(0)
  await expect(reply.getByTestId('unplaced')).toContainText('waiting for api to place it')
})

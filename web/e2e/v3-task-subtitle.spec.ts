// The agent's Tasks list shows, under each task's title, where it stands in a line or two: the summary
// the agent keeps, else its latest report, else the agent's latest message about it (plain text), else
// the step it is on. The Board's row says the same thing.
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

test('agent Tasks list: a subtitle from the summary, else the latest message; the Board says the same', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)

  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const item = page.locator(`[data-testid="agent-tasks"] [data-testid="agent-task"][data-task="${gauge.id}"]`)
  await expect(item).toHaveCount(1)
  // No summary or report yet: the agent's latest message about it, as plain text.
  const sub = item.getByTestId('task-standing')
  await expect(sub).toHaveAttribute('data-from', 'message')
  await expect(sub).toContainText('On it. I created a task for this')
  // The meta line stays below it.
  await expect(item.locator('.v-b')).toContainText('Working')

  // The agent sets a summary: it is the subtitle, here and on the Board.
  await api(minbox, 'PATCH', `/api/v3/tasks/${gauge.id}`, { summary: 'Found the **rounding** bug; writing the fix' })
  await expect(sub).toHaveAttribute('data-from', 'summary')
  await expect(sub).toHaveText('Found the rounding bug; writing the fix')
  // Clamped to two lines.
  expect(await sub.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe('2')

  await page.goto(minbox.url)
  const row = page.locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)
  await expect(row.getByTestId('task-standing')).toHaveText('Found the rounding bug; writing the fix')
})

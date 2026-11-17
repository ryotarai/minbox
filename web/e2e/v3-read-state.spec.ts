// UC12 (read state that just works): messages are read when shown, in the stream or in the task view;
// the Agents list counts unread, Board rows show a dot while a tagged message is unread.
import { test, expect } from './fixtures'
import { agentReply, board, say, startAgent, taskNamed } from './v3'

test('reading a task marks its messages read; the stream marks the rest', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'is the staging server up?')
  await agentReply(minbox, a, /Sure — noted/)

  await page.goto(minbox.url)
  const row = page.locator(`[data-testid="task-row"][data-task="${t.id}"]`)
  await expect(row.getByTestId('unread-dot')).toBeVisible()
  await expect(page.locator(`[data-testid="agent-row"][data-session="${a.id}"]`).getByTestId('agent-unread')).toHaveText('2')

  // The task view reads its tagged message; the untagged one stays unread.
  await row.locator('.v-line').dblclick()
  await expect(page.getByTestId('task-view')).toBeVisible()
  await expect.poll(async () => (await board(minbox)).agents[a.id].unread).toBe(1)
  await expect(page.locator(`[data-testid="agent-row"][data-session="${a.id}"]`).getByTestId('agent-unread')).toHaveText('1')
  await page.keyboard.press('Escape')
  await expect(row.getByTestId('unread-dot')).toHaveCount(0)

  // The stream reads the rest.
  await page.locator(`[data-testid="agent-row"][data-session="${a.id}"]`).click()
  await expect.poll(async () => (await board(minbox)).agents[a.id].unread).toBe(0)
  await expect(page.locator(`[data-testid="agent-row"][data-session="${a.id}"]`).getByTestId('agent-unread')).toHaveCount(0)
})

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
  await row.locator('.v-line').click()
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

// A task with an unread agent message about it shows its title in bold (the Tasks pane, the Board);
// seeing it (the task opened in the agent's page) makes it normal, and a reload keeps it read.
test('a task with unread agent messages is bold in the Tasks pane until opened', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task.*gauge/)
  await say(minbox, a, 'please update the billing export')
  const billing = await taskNamed(minbox, /Update the billing export/)
  await agentReply(minbox, a, /created a task.*billing/)

  // The Board: both bold while unread.
  await page.goto(minbox.url)
  const boardTitle = (id: string) => page.locator(`[data-testid="task-row"][data-task="${id}"] .v-t`)
  await expect(boardTitle(gauge.id)).toHaveAttribute('data-unread', 'true')
  await expect(boardTitle(billing.id)).toHaveAttribute('data-unread', 'true')
  expect(await boardTitle(billing.id).evaluate((e) => getComputedStyle(e).fontWeight)).toBe('600')

  // The agent's page with the gauge task open (not the stream): the gauge task is read, billing stays bold.
  await page.goto(minbox.url + `/#v=agent&s=${a.id}&k=${gauge.id}`)
  const pane = page.getByTestId('tasks-pane')
  const title = (id: string) => pane.locator(`[data-testid="agent-task"][data-task="${id}"] .v-a`)
  await expect(title(gauge.id)).not.toHaveAttribute('data-unread', /.*/)
  expect(await title(gauge.id).evaluate((e) => getComputedStyle(e).fontWeight)).toBe('400')
  await expect(title(billing.id)).toHaveAttribute('data-unread', 'true')
  expect(await title(billing.id).evaluate((e) => getComputedStyle(e).fontWeight)).toBe('600')

  // Opening it reads it: normal weight.
  await pane.locator(`[data-testid="agent-task"][data-task="${billing.id}"]`).click()
  await expect(page.getByTestId('agent-task-detail')).toBeVisible()
  await expect(title(billing.id)).not.toHaveAttribute('data-unread', /.*/)

  // Back on the gauge task, a new agent reply about billing makes it bold live (the person's own
  // message about it does not count).
  await pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`).click()
  await say(minbox, a, 'the billing export needs a header row')
  await agentReply(minbox, a, /adding this to “Update the billing export”/)
  await expect(title(billing.id)).toHaveAttribute('data-unread', 'true')
  await expect(title(gauge.id)).not.toHaveAttribute('data-unread', /.*/)
  await pane.locator(`[data-testid="agent-task"][data-task="${billing.id}"]`).click()
  await expect(title(billing.id)).not.toHaveAttribute('data-unread', /.*/)
  await expect.poll(async () => (await board(minbox)).tasks.find((t: any) => t.id === billing.id).unread).toBe(0)

  // A reload keeps it read.
  await page.reload()
  await expect(title(gauge.id)).toBeVisible()
  await expect(title(billing.id)).not.toHaveAttribute('data-unread', /.*/)
  await expect(title(gauge.id)).not.toHaveAttribute('data-unread', /.*/)
})

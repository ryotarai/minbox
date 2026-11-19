// UC1 (morning triage), UC5 (progress inline), UC10 (close done work): the Board answers "what
// needs me, and what is moving?" at a glance. NEEDS YOU is the tasks set to needs you; a task with an
// open question stays in its group with "? n", and the question is answered in the task. Any row opens
// its task on a click.
import { test, expect } from './fixtures'
import { agentReply, board, openAsks, say, shot, startAgent, taskNamed } from './v3'

test('triage on the Board: a question is "? n" on its task row, Enter opens the task to answer it, X closes', async ({ page, minbox }) => {
  const api = await startAgent(minbox, 'api')
  await say(minbox, api, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, api, /created a task/)
  await say(minbox, api, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, api, /One decision first/)
  await say(minbox, api, 'is the staging server up?')
  await agentReply(minbox, api, /Sure — noted/)

  await page.goto(minbox.url)
  // No per-question entries: the task is working (its status), so NEEDS YOU is empty.
  await expect(page.getByTestId('group-needs_you').getByTestId('task-row')).toHaveCount(0)
  await expect(page.getByTestId('needs-count')).toHaveText('0 need you')
  await expect(page.getByTestId('board-badge')).toHaveCount(0)
  const row = page.getByTestId('group-working').locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)
  await expect(row).toContainText('? 1')
  await expect(row.getByTestId('progress')).toBeVisible()
  await expect(row.locator('.v-dot').first()).not.toHaveClass(/d-wait/)
  await shot(page, 'uc1-board', 'dark')
  await shot(page, 'uc1-board', 'light')

  // J focuses the row; Enter opens the task, where the question is answered.
  await page.keyboard.press('j')
  await expect(row).toHaveClass(/\bfocus\b/)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`v=agent.*k=${gauge.id}`))
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await msg.getByTestId('question').getByText('Oregon', { exact: true }).click()
  await msg.getByTestId('send-answers').click()
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
  await agentReply(minbox, api, /carrying on/)
  await expect.poll(async () => openAsks(minbox, api)).toBe(0)

  // Back on the Board: no "? n" left. A click on the task row opens the task; Esc comes back.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page.locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).not.toContainText('? 1')
  await page.locator(`[data-testid="task-row"][data-task="${gauge.id}"] .v-line`).click()
  await expect(page).toHaveURL(new RegExp(`v=agent.*k=${gauge.id}`))
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading on the dashboard')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page.getByTestId('task-expanded')).toHaveCount(0)
  // The clicked row keeps the focus (Space no longer unfolds anything on the Board).
  await expect(page.locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).toHaveClass(/focus/)
  await page.keyboard.press(' ')
  await expect(page.getByTestId('task-expanded')).toHaveCount(0)
  await expect(page.getByTestId('board')).toBeVisible()

  // X marks it done; it leaves WORKING for DONE.
  await page.keyboard.press('x')
  await expect(page.getByTestId('group-working').locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).toHaveCount(0)
  await page.getByTestId('toggle-done').click()
  await expect(page.getByTestId('group-done').locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).toHaveCount(1)
  expect((await board(minbox)).tasks.find((t: any) => t.id === gauge.id)?.status).toBe('done')
})

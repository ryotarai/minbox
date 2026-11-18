// UC1 (morning triage), UC5 (progress inline), UC10 (close done work): the Board answers "what
// needs me, and what is moving?" at a glance. A question is a compact row there; it is answered in its
// task (a click or Enter opens the task at the question). Any row opens its task on a click.
import { test, expect } from './fixtures'
import { agentReply, board, say, shot, startAgent, taskNamed } from './v3'

test('triage on the Board: compact question rows, Enter answers in the task, a click opens a row’s task, X closes', async ({ page, minbox }) => {
  const api = await startAgent(minbox, 'api')
  await say(minbox, api, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, api, /created a task/)
  await say(minbox, api, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, api, /One decision first/)
  await say(minbox, api, 'is the staging server up?')
  await agentReply(minbox, api, /Sure — noted/)

  await page.goto(minbox.url)
  const card = page.getByTestId('question-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId('ask')).toHaveText('you: Which region should it deploy to?')
  await expect(card.getByTestId('ask-task')).toHaveText('Fix the gauge reading on the dashboard')
  await expect(card.getByTestId('progress')).toBeVisible()
  await expect(page.getByTestId('needs-count')).toHaveText('1 need you')
  await expect(page.getByTestId('board-badge')).toHaveText('1')
  const row = page.locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)
  await expect(row).toContainText('? 1')
  await expect(row.getByTestId('progress')).toBeVisible()
  await shot(page, 'uc1-board', 'dark')
  await shot(page, 'uc1-board', 'light')

  // The task of the question is on the row, not repeated as a task row in NEEDS YOU.
  await expect(page.getByTestId('group-needs_you').getByTestId('task-row')).toHaveCount(0)
  // J focuses the row; the Board does not answer (no 1–9, no ⌘↵): Enter opens the task at the question.
  await page.keyboard.press('j')
  await expect(card).toHaveClass(/focus/)
  await page.keyboard.press('1')
  await page.keyboard.press('ControlOrMeta+Enter')
  await page.waitForTimeout(300)
  expect((await board(minbox)).questions).toHaveLength(1)
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`v=agent.*k=${gauge.id}`))
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await expect(msg).toHaveClass(/\bhl\b/)
  await msg.getByTestId('question').getByText('Oregon', { exact: true }).click()
  await msg.getByTestId('send-answers').click()
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
  await agentReply(minbox, api, /carrying on/)
  await expect.poll(async () => (await board(minbox)).questions.length).toBe(0)

  // Back on the Board: the row is gone. A click on the task row opens the task; Esc comes back.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page.getByTestId('question-card')).toHaveCount(0)
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
  await expect(page.getByTestId('group-working').getByTestId('task-row')).toHaveCount(0)
  await page.getByTestId('toggle-done').click()
  // (the quick exchange's own small task is done too)
  await expect(page.getByTestId('group-done').locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).toHaveCount(1)
})

test('NEEDS YOU rows are compact (nothing to answer on the Board) and open the task at the question on click', async ({ page, minbox }) => {
  const api = await startAgent(minbox, 'api')
  await say(minbox, api, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, api, /created a task/)
  await say(minbox, api, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, api, /One decision first/)
  await say(minbox, api, 'TODOS for the gauge')
  await agentReply(minbox, api, /Two things for you/)

  await page.goto(minbox.url)
  const needs = page.getByTestId('group-needs_you')
  const rows = needs.getByTestId('question-card')
  await expect(rows).toHaveCount(2)
  await expect(page.getByTestId('needs-count')).toHaveText('2 need you')
  await expect(needs.locator('.v-gh .v-n')).toHaveText('2')
  // One line of ask each, never empty: a question's prompt, or the first thing to do +n.
  const ask = needs.locator(`[data-message="${q.id}"]`)
  await expect(ask.getByTestId('ask')).toHaveText('you: Which region should it deploy to?')
  await expect(rows.filter({ hasText: 'Restart the staging box' }).getByTestId('ask')).toHaveText('you: Restart the staging box +1')
  // Nothing to answer here: no choices, no inputs, no Done / Can't do it, no Send.
  await expect(needs.getByTestId('choice')).toHaveCount(0)
  await expect(needs.getByTestId('action-item')).toHaveCount(0)
  await expect(needs.getByTestId('answer-bar')).toHaveCount(0)
  await expect(needs.locator('input, textarea')).toHaveCount(0)
  for (const r of await rows.all()) expect((await r.boundingBox())!.height).toBeLessThan(70)

  // A click opens the task at the question (nothing unfolds on the Board).
  await ask.locator('.v-line').click()
  await expect(page).toHaveURL(new RegExp(`v=agent.*k=${gauge.id}`))
  await expect(page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)).toHaveClass(/\bhl\b/)
})

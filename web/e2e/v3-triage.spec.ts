// UC1 (morning triage), UC5 (progress inline), UC10 (close done work): the Board answers "what
// needs me, and what is moving?" without opening anything. A question is a compact row there; it is
// answered in its task (Enter, or the row's Answer in task button).
import { test, expect } from './fixtures'
import { agentReply, board, say, shot, startAgent, taskNamed } from './v3'

test('triage on the Board: compact question rows, rows expand in place, Enter answers in the task, X closes', async ({ page, minbox }) => {
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
  await expect(page).toHaveURL(new RegExp(`v=task.*k=${gauge.id}`))
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await expect(msg).toHaveClass(/\bhl\b/)
  await msg.getByTestId('question').getByText('Oregon', { exact: true }).click()
  await msg.getByTestId('send-answers').click()
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
  await agentReply(minbox, api, /carrying on/)
  await expect.poll(async () => (await board(minbox)).questions.length).toBe(0)

  // Back on the Board: the row is gone. J then Space expands the task row: checklist, last report, timeline.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page.getByTestId('question-card')).toHaveCount(0)
  await page.keyboard.press('j')
  await page.keyboard.press(' ')
  const exp = page.getByTestId('task-expanded')
  await expect(exp).toBeVisible()
  await expect(exp.getByTestId('step')).toHaveCount(4)
  await expect(exp.getByTestId('timeline')).toContainText('You:')
  await expect(exp.getByTestId('facts')).toContainText('Status')
  await shot(page, 'uc5-expanded', 'light')

  // X marks it done; it leaves WORKING for DONE.
  await page.keyboard.press('x')
  await expect(page.getByTestId('group-working').getByTestId('task-row')).toHaveCount(0)
  await page.getByTestId('toggle-done').click()
  // (the quick exchange's own small task is done too)
  await expect(page.getByTestId('group-done').locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).toHaveCount(1)
})

test('NEEDS YOU rows are compact (nothing to answer on the Board) and expand on click', async ({ page, minbox }) => {
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

  // A click expands it in place: the ask in full, the checklist, timeline and facts, and Answer in task.
  await ask.locator('.v-line').click()
  const exp = ask.getByTestId('task-expanded')
  await expect(exp).toBeVisible()
  await expect(exp.getByTestId('ask-list')).toContainText('Which region should it deploy to?')
  await expect(exp.getByTestId('step')).toHaveCount(4)
  await expect(exp.getByTestId('timeline')).toBeVisible()
  await expect(exp.getByTestId('facts')).toContainText('last activity')
  await expect(exp.locator('input, textarea, [data-testid="choice"]')).toHaveCount(0)
  // Space folds it again (the row is focused by the click).
  await page.keyboard.press(' ')
  await expect(exp).toHaveCount(0)
  await ask.locator('.v-line').click()
  await exp.getByTestId('answer-in-task').click()
  await expect(page).toHaveURL(new RegExp(`v=task.*k=${gauge.id}`))
  await expect(page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)).toHaveClass(/\bhl\b/)
})

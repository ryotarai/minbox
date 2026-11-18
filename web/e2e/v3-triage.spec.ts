// UC1 (morning triage), UC5 (progress inline), UC10 (close done work): the Board answers "what
// needs me, and what is moving?" without opening anything.
import { test, expect } from './fixtures'
import { agentReply, board, say, shot, startAgent, taskNamed } from './v3'

test('triage on the Board: question cards first, rows expand in place, 1–9 answers, X closes', async ({ page, minbox }) => {
  const api = await startAgent(minbox, 'api')
  await say(minbox, api, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, api, /created a task/)
  await say(minbox, api, 'ASK about the gauge deploy')
  await agentReply(minbox, api, /One decision first/)
  await say(minbox, api, 'is the staging server up?')
  await agentReply(minbox, api, /Sure — noted/)

  await page.goto(minbox.url)
  const card = page.getByTestId('question-card')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('you: Which region should it deploy to?')
  await expect(card.getByTestId('task-link')).toHaveAttribute('title', 'Fix the gauge reading on the dashboard')
  await expect(page.getByTestId('needs-count')).toHaveText('1 need you')
  await expect(page.getByTestId('board-badge')).toHaveText('1')
  const row = page.locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)
  await expect(row).toContainText('? 1')
  await expect(row.getByTestId('progress')).toBeVisible()
  await shot(page, 'uc1-board', 'dark')
  await shot(page, 'uc1-board', 'light')

  // The task of the question is on the card, not repeated as a row in NEEDS YOU.
  await expect(page.getByTestId('group-needs_you').getByTestId('task-row')).toHaveCount(0)
  // J focuses the card, 1 picks the first choice (nothing sent), ⌘↵ sends: the card goes.
  await page.keyboard.press('j')
  await expect(card).toHaveClass(/focus/)
  await page.keyboard.press('1')
  await expect(card.getByTestId('choice').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(card).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
  await agentReply(minbox, api, /carrying on/)
  // The answer is tagged with the question's task and reached the agent.
  await expect.poll(async () => (await board(minbox)).questions.length).toBe(0)

  // J then Space expands the task row: checklist and last report (no timeline).
  await page.keyboard.press('j')
  await page.keyboard.press(' ')
  const exp = page.getByTestId('task-expanded')
  await expect(exp).toBeVisible()
  await expect(exp.getByTestId('step')).toHaveCount(4)
  await expect(exp.getByTestId('timeline')).toHaveCount(0)
  await shot(page, 'uc5-expanded', 'light')

  // X marks it done; it leaves WORKING for DONE.
  await page.keyboard.press('x')
  await expect(page.getByTestId('group-working').getByTestId('task-row')).toHaveCount(0)
  await page.getByTestId('toggle-done').click()
  // (the quick exchange's own small task is done too)
  await expect(page.getByTestId('group-done').locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).toHaveCount(1)
})

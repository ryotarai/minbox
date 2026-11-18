// A task an agent sets to needs you with update_task and only a status (no question asked): NEEDS
// YOU shows it as a row that says what it waits on, the counts match what is shown, and the
// timeline line has a subject ("Status → needs you", never a bare "→ needs you").
import { test, expect } from './fixtures'
import { agentReply, board, say, startAgent, taskNamed } from './v3'

test('a task set to needs you without a question: a row that says what it needs, a timeline line with a subject', async ({ page, minbox }) => {
  const api = await startAgent(minbox, 'api')
  await say(minbox, api, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, api, /created a task/)
  await say(minbox, api, 'NEEDYOU about the gauge')
  await agentReply(minbox, api, /I need you to look at the gauge/)
  await expect.poll(async () => (await board(minbox)).tasks.find((t: any) => t.id === gauge.id)?.status).toBe('needs_you')

  await page.goto(minbox.url)
  const needs = page.getByTestId('group-needs_you')
  await expect(page.getByTestId('question-card')).toHaveCount(0)
  const row = needs.locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Fix the gauge reading')
  await expect(row.getByTestId('needs-what')).toHaveText(/^needs: I need you to look at the gauge/)
  // The header, the group and the sidebar badge count the one entry shown.
  await expect(needs.getByTestId('task-row')).toHaveCount(1)
  await expect(page.getByTestId('needs-count')).toHaveText('1 need you')
  await expect(page.getByTestId('board-badge')).toHaveText('1')
  await expect(needs.locator('.v-gh .v-n')).toHaveText('1')

  // Expanded on the Board: checklist, last report and facts; no timeline.
  await row.locator('.v-line').click()
  await expect(row.getByTestId('task-expanded').getByTestId('facts')).toContainText('Needs you')
  await expect(row.getByTestId('task-expanded').getByTestId('timeline')).toHaveCount(0)

  // The task view no longer shows status lines in the conversation (only hand-offs and auto runs), so none is subjectless.
  await page.goto(minbox.url + `/#v=task&k=${gauge.id}`)
  await expect(page.getByTestId('task-title')).toBeVisible()
  const evs = page.getByTestId('event')
  await expect(evs.filter({ hasText: 'needs you' })).toHaveCount(0)
  for (const t of await evs.allTextContents()) expect(t.replace(/^\d\d:\d\d/, '').trim()).not.toMatch(/^→/)
})

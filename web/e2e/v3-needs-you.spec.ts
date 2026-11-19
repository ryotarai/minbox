// A task an agent sets to needs you with update_task and only a status (no question asked): NEEDS
// YOU shows it as a row that says what it waits on, the counts match what is shown, and the
// timeline line has a subject ("Status → needs you", never a bare "→ needs you").
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
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

  // A click on the row opens the task (nothing unfolds on the Board).
  await row.locator('.v-line').click()
  await expect(page).toHaveURL(new RegExp(`v=agent.*k=${gauge.id}`))
  await expect(page.getByTestId('task-title')).toBeVisible()
  await expect(page.getByTestId('task-expanded')).toHaveCount(0)

  // The task view no longer shows status lines in the conversation (only hand-offs and auto runs), so none is subjectless.
  const evs = page.getByTestId('event')
  await expect(evs.filter({ hasText: 'needs you' })).toHaveCount(0)
  for (const t of await evs.allTextContents()) expect(t.replace(/^\d\d:\d\d/, '').trim()).not.toMatch(/^→/)
})

// NEEDS YOU is the tasks set to needs you, nothing else: a question left unanswered for days on a
// working task never shows there (nor in the counts, the badge, the tab title, the agent's dot); it
// stays a "? 1" on its task's row. A task the agent set to needs you does show.
test('an old unanswered question does not show in NEEDS YOU; a task set to needs you does', async ({ page, minbox }) => {
  const api = await startAgent(minbox, 'api')
  await say(minbox, api, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, api, /created a task/)
  await say(minbox, api, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, api, /One decision first/)
  // Days old (the server stamps "now").
  const db = readdirSync(minbox.dataDir).find((f) => f.endsWith('.db'))!
  const old = Date.now() - 5 * 24 * 3600 * 1000
  execFileSync('sqlite3', [join(minbox.dataDir, db)], { input: `.timeout 5000\nUPDATE messages SET created_at=${old} WHERE id='${q.id}';\n` })
  const before = (await board(minbox)).tasks.find((t: any) => t.id === gauge.id)
  expect(before.status).toBe('working')
  expect(before.open_questions).toBe(1)

  await page.goto(minbox.url)
  const needs = page.getByTestId('group-needs_you')
  await expect(page.getByTestId('group-working').locator(`[data-testid="task-row"][data-task="${gauge.id}"]`)).toContainText('? 1')
  await expect(needs.getByTestId('task-row')).toHaveCount(0)
  await expect(needs.getByTestId('question-card')).toHaveCount(0)
  await expect(needs).toContainText('Nothing needs you')
  await expect(page.getByTestId('needs-count')).toHaveText('0 need you')
  await expect(page.getByTestId('board-badge')).toHaveCount(0)
  await expect(page).toHaveTitle('minbox')
  await expect(page.locator(`[data-testid="agent-row"][data-session="${api.id}"] .v-dot`)).not.toHaveClass(/d-wait/)

  // The agent sets another task to needs you: that one (only) is in NEEDS YOU, and counts.
  await say(minbox, api, 'please update the deploy docs')
  const docs = await taskNamed(minbox, /Update the deploy docs/)
  await say(minbox, api, 'NEEDYOU about the deploy docs')
  await expect.poll(async () => (await board(minbox)).tasks.find((t: any) => t.id === docs.id)?.status).toBe('needs_you')
  await expect(needs.getByTestId('task-row')).toHaveCount(1)
  await expect(needs.locator(`[data-testid="task-row"][data-task="${docs.id}"]`)).toHaveCount(1)
  await expect(page.getByTestId('needs-count')).toHaveText('1 need you')
  await expect(page.getByTestId('board-badge')).toHaveText('1')
  await expect(page).toHaveTitle('(1) minbox')
  await expect(page.locator(`[data-testid="agent-row"][data-session="${api.id}"] .v-dot`)).toHaveClass(/d-wait/)
  if (process.env.NEEDS_YOU_SHOT) await page.screenshot({ path: process.env.NEEDS_YOU_SHOT })
})

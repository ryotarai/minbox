// The project rail's yellow badge is the project's tasks whose status is needs_you: an unanswered
// question on a working task never counts, and the badge follows a task's status live.
import { test, expect } from './fixtures'
import { agentReply, api, board, say, startAgent, taskNamed } from './v3'

async function setStatus(m: Parameters<typeof board>[0], id: string, status: string) {
  await api(m, 'PATCH', `/api/v3/tasks/${id}`, { status })
}

test('the rail badge counts needs_you tasks, not unanswered questions, and updates live', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api', 'alpha')
  await say(minbox, a, 'please fix the gauge reading on the dashboard')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  await agentReply(minbox, a, /One decision first/)
  const before = (await board(minbox)).tasks.find((t: any) => t.id === gauge.id)
  expect(before.status).toBe('working')
  expect(before.open_questions).toBe(1)

  await page.goto(minbox.url)
  const item = page.locator(`[data-testid="project-item"][data-project-id="${a.project_id}"]`)
  const all = page.getByTestId('project-all')
  await expect(item).toHaveCount(1)
  // An unanswered question alone: no yellow badge.
  await expect(item.getByTestId('project-waiting')).toHaveCount(0)
  await expect(all).not.toContainText('needs you')

  // The task is set to needs you: the badge shows 1, live (no reload).
  await setStatus(minbox, gauge.id, 'needs_you')
  await expect(item.getByTestId('project-waiting')).toHaveText('1')
  await expect(item.getByTestId('project-waiting')).toHaveAttribute('aria-label', '1 task needs you')
  // All projects (a tile in the closed rail: its count is for screen readers and the tooltip).
  await expect(all).toContainText('1 task needs you')
  await expect(all).toHaveAttribute('title', /1 task needs you/)

  // A second task set to needs you: 2.
  await say(minbox, a, 'please update the deploy docs')
  const docs = await taskNamed(minbox, /Update the deploy docs/)
  await setStatus(minbox, docs.id, 'needs_you')
  await expect(item.getByTestId('project-waiting')).toHaveText('2')
  await expect(item.getByTestId('project-waiting')).toHaveAttribute('aria-label', '2 tasks need you')

  // Back to working and done: the badge goes, the question still open.
  await setStatus(minbox, gauge.id, 'working')
  await expect(item.getByTestId('project-waiting')).toHaveText('1')
  await setStatus(minbox, docs.id, 'done')
  await expect(item.getByTestId('project-waiting')).toHaveCount(0)
  await expect(all).not.toContainText('needs you')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the phone project sheet shows the same needs_you count', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api', 'alpha')
    await say(minbox, a, 'please fix the gauge reading on the dashboard')
    const gauge = await taskNamed(minbox, /Fix the gauge reading/)
    await agentReply(minbox, a, /created a task/)
    await say(minbox, a, 'ASK about the gauge deploy')
    await agentReply(minbox, a, /One decision first/)

    await page.goto(minbox.url)
    await page.getByTestId('tab-agents').tap()
    const sw = page.getByTestId('project-switch')
    await expect(sw).toBeVisible()
    await expect(sw.getByTestId('project-waiting')).toHaveCount(0)
    await setStatus(minbox, gauge.id, 'needs_you')
    await expect(sw.getByTestId('project-waiting')).toHaveText('1')

    await sw.tap()
    const sheet = page.getByTestId('project-sheet')
    await expect(sheet.getByTestId('project-all').getByTestId('project-waiting')).toHaveText('1')
    await expect(sheet.locator(`[data-testid="project-item"][data-project-id="${a.project_id}"]`).getByTestId('project-waiting')).toHaveText('1')
    await setStatus(minbox, gauge.id, 'done')
    await expect(sheet.getByTestId('project-waiting')).toHaveCount(0)
  })
})

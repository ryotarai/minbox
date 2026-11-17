// UC13 (set a goal and let an agent run toward it): the person just writes; the agent makes it a goal
// with criteria and an autonomous run. The Board shows it under GOALS with its run; minbox continues
// the agent until the criteria are met; the person can pause, resume and stop it.
import { test, expect } from './fixtures'
import { agentReply, api, say, shot, startAgent } from './v3'

test('a goal runs by itself until its criteria are met; pause and stop from the Board', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(minbox.url)
  await say(minbox, a, 'GOAL: CI green on main\n- unit tests pass\n- e2e pass')
  const goals = page.getByTestId('group-goals')
  const row = goals.locator('[data-testid="task-row"][data-kind="goal"]')
  await expect(row).toContainText('CI green on main', { timeout: 20_000 })
  // minbox continues the agent on its own; the second continuation meets the criteria (fake agent).
  await agentReply(minbox, a, /Goal progress: step 1 done/)
  await agentReply(minbox, a, /All criteria are met/)
  await expect(goals).toHaveCount(0) // a met goal is done: it leaves GOALS
  await page.getByTestId('toggle-done').click()
  const done = page.getByTestId('group-done').locator('[data-testid="task-row"][data-kind="goal"]')
  await expect(done.getByTestId('goal-run')).toHaveCount(0)
  await expect(done).toContainText('met')
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  expect(s.messages.filter((m: any) => m.kind === 'continue')).toHaveLength(2)

  // A second goal without a run (the person did not ask for one): Start, Pause, Stop from the Board.
  await say(minbox, a, 'GOAL: Docs published (manual)\n- site deployed')
  const g2 = page.getByTestId('group-goals').locator('[data-testid="task-row"][data-kind="goal"]')
  await expect(g2).toContainText('Docs published', { timeout: 20_000 })
  const run = g2.getByTestId('goal-run')
  await expect(run).toHaveAttribute('data-state', 'off')
  await run.getByTestId('goal-start').click()
  await expect(run).toHaveAttribute('data-state', 'running')
  await run.getByTestId('goal-pause').click()
  await expect(run).toHaveAttribute('data-state', 'paused')
  await shot(page, 'uc13-goal', 'dark')
  await run.getByTestId('goal-start').click()
  await expect(run).toHaveAttribute('data-state', 'running')
  await run.getByTestId('goal-stop').click()
  await expect(run).toHaveAttribute('data-state', 'stopped')
  await expect(run.getByTestId('goal-start')).toHaveText('Start run')
})

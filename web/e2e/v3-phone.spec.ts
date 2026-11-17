// UC11 (get notified and act from the phone): one column, bottom tabs Board · Agents · Search; a task
// folds its checklist on top; the Agents tab lists the streams; no horizontal scrolling.
import { test, expect } from './fixtures'
import { agentReply, say, shot, startAgent, taskNamed } from './v3'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

test('phone: tabs, a task with its details folded, an agent stream, no horizontal scroll', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  await agentReply(minbox, a, /One decision first/)

  await page.goto(minbox.url)
  await expect(page.getByTestId('phone-tabs')).toBeVisible()
  await expect(page.getByTestId('sidebar')).toHaveCount(0)
  await expect(page.getByTestId('tab-board')).toHaveClass(/on/)
  await expect(page.getByTestId('tab-board')).toContainText('1')
  await shot(page, 'uc11-phone-board', 'dark')
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  expect(await noHScroll()).toBe(true)

  // A row opens the task: details folded behind a button, messages, the reply at the bottom.
  await page.locator(`[data-testid="task-row"][data-task="${t.id}"] .v-line`).tap()
  await page.getByTestId('open-task').tap()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  // The details (checklist, report, facts) are folded on a phone; one tap opens them.
  await expect(page.getByTestId('task-side')).toHaveCount(0)
  await page.getByRole('button', { name: 'Details' }).tap()
  await expect(page.getByTestId('task-side')).toBeVisible()
  await expect(page.getByTestId('task-side').getByTestId('step')).toHaveCount(4)
  await expect(page.getByTestId('task-composer')).toBeVisible()
  await shot(page, 'uc11-phone-task', 'light')
  expect(await noHScroll()).toBe(true)

  // Agents tab → the agent → its stream.
  await page.getByTestId('tab-agents').tap()
  await expect(page.getByTestId('agents-view')).toBeVisible()
  await page.getByTestId('agent-row').first().tap()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await expect(page.getByTestId('tab-agents')).toHaveClass(/on/)
  await shot(page, 'uc11-phone-stream', 'dark')
  expect(await noHScroll()).toBe(true)

  // Search tab.
  await page.getByTestId('tab-search').tap()
  await page.getByTestId('search-input').fill('gauge')
  await expect(page.getByTestId('search-task')).toHaveCount(1)
})

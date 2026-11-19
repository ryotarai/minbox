// UC11 (get notified and act from the phone): one column, bottom tabs Board · Agents · Search; a task
// opens in its agent's page with its checklist in its card, below the title; the Agents tab lists the
// streams; no horizontal scrolling.
import { test, expect } from './fixtures'
import { agentReply, say, shot, startAgent, taskNamed } from './v3'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

test('phone: tabs, a task in its agent page with its checklist, an agent stream, no horizontal scroll', async ({ page, minbox }) => {
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
  // The tab counts NEEDS YOU (tasks set to needs you): the open question alone adds nothing.
  await expect(page.getByTestId('tab-board')).toHaveText('Board')
  await shot(page, 'uc11-phone-board', 'dark')
  const noHScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  expect(await noHScroll()).toBe(true)

  // A tap on a row opens the task in its agent's page: its card (the checklist below the title), its
  // messages, the reply at the bottom.
  await page.locator(`[data-testid="task-row"][data-task="${t.id}"] .v-line`).tap()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(page).toHaveURL(new RegExp(`s=${a.id}.*v=agent.*k=${t.id}`))
  const check = page.getByTestId('task-card').getByTestId('task-checklist')
  // Four steps: folded to the progress bar (no count) at first; a tap on it shows them.
  await expect(check.getByTestId('progress')).toBeVisible()
  await expect(check.getByTestId('step')).toHaveCount(0)
  await check.getByTestId('task-checklist-toggle').tap()
  await expect(check.getByTestId('step')).toHaveCount(4)
  const title = (await page.getByTestId('task-title').boundingBox())!
  expect((await check.boundingBox())!.y).toBeGreaterThan(title.y + title.height - 1)
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

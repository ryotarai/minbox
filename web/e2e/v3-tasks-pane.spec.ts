// The agent's Tasks pane sits between the agents list and the stream: [rail] | [agents] | [tasks] |
// [stream] | [terminal, shell, files when one is open]. Its width drags and is kept; it folds to a strip
// (its « button, the strip, ⇧T, the palette) and stays folded across reloads. A task opens the task
// view; back returns to the agent. On a tablet it is a strip that unfolds over the stream.
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures'
import { agentReply, say, startAgent, taskNamed } from './v3'

const SHOTS = process.env.TASKS_PANE_SHOTS // a folder: screenshots (light and dark)
async function snap(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` })
  }
}
const box = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!

test('desktop: agents | tasks | stream | terminal; the pane drags, folds (« · ⇧T · palette) and is kept; a task opens and back returns', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.setViewportSize({ width: 1800, height: 900 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)

  const pane = page.getByTestId('tasks-pane')
  await expect(pane).toHaveAttribute('data-shown', 'true')
  await expect(pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`)).toBeVisible()
  await expect(pane.getByTestId('task-standing')).toBeVisible()
  // No side pane until the terminal, shell or files open; no Tasks tab in it.
  await expect(page.getByTestId('agent-side')).toHaveCount(0)

  // The order, left to right.
  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(page.getByTestId('pane-tasks')).toHaveCount(0)
  const sb = await box(page, 'sidebar')
  const tp = await box(page, 'tasks-pane')
  const sv = await box(page, 'stream-view')
  const side = await box(page, 'agent-side')
  expect(sb.x + sb.width).toBeLessThanOrEqual(tp.x + 1)
  expect(tp.x + tp.width).toBeLessThanOrEqual(sv.x + 1)
  expect(sv.x + sv.width).toBeLessThanOrEqual(side.x + 1)
  expect(sv.width).toBeGreaterThanOrEqual(380)
  await snap(page, 'desktop-terminal')
  await page.getByTestId('side-close').click()
  await expect(page.getByTestId('agent-side')).toHaveCount(0)
  await snap(page, 'desktop')

  // Its edge drags; the width is kept.
  const w0 = tp.width
  const rz = await box(page, 'tasks-resizer')
  await page.mouse.move(rz.x + rz.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(rz.x + rz.width / 2 + 40, 400, { steps: 4 })
  await page.mouse.move(rz.x + rz.width / 2 + 60, 400, { steps: 4 })
  await page.mouse.up()
  const w1 = (await box(page, 'tasks-pane')).width
  expect(Math.abs(w1 - (w0 + 60))).toBeLessThan(4)
  await page.reload()
  await expect(pane).toHaveAttribute('data-shown', 'true')
  expect(Math.abs((await box(page, 'tasks-pane')).width - w1)).toBeLessThan(2)

  // « folds it to a strip with the open count; folded across a reload; the strip unfolds it.
  await page.getByTestId('tasks-pane-toggle').click()
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await expect(pane.getByTestId('agent-tasks')).toHaveCount(0)
  await expect(page.getByTestId('tasks-pane-toggle')).toContainText('1')
  expect((await box(page, 'tasks-pane')).width).toBeLessThan(50)
  await snap(page, 'desktop-folded')
  await page.reload()
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await page.getByTestId('tasks-pane-toggle').click()
  await expect(pane).toHaveAttribute('data-shown', 'true')

  // ⇧T folds and unfolds it.
  await page.getByTestId('stream-view').locator('.v-scroll').click()
  await page.keyboard.press('Shift+T')
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await page.keyboard.press('Shift+T')
  await expect(pane).toHaveAttribute('data-shown', 'true')

  // The palette has it too, with its key.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('>tasks pane')
  const act = page.getByText('Hide tasks pane')
  await expect(act).toBeVisible()
  await act.click()
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await page.getByTestId('tasks-pane-toggle').click()

  // The help lists ⇧T.
  await page.getByTestId('stream-view').locator('.v-scroll').click()
  await page.keyboard.press('?')
  await expect(page.getByTestId('help-dialog')).toContainText('Tasks pane of the agent')
  await page.keyboard.press('Escape')

  // A task opens the task view (no Tasks pane there); back returns to the agent.
  await pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`).click()
  await expect(page.getByTestId('task-title')).toHaveText(/Fix the gauge reading/)
  await expect(page.getByTestId('tasks-pane')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', a.id)
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
})

test('tablet 900px: the Tasks pane is a strip that unfolds over the stream; a task or Esc folds it', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  const pane = page.getByTestId('tasks-pane')
  await expect(pane).toHaveAttribute('data-overlay', 'true')
  await expect(pane).toHaveAttribute('data-shown', 'false')
  const s0 = await box(page, 'stream-view')
  expect(s0.width).toBeGreaterThan(900 - 56 - 34 - 10)

  await page.getByTestId('tasks-pane-toggle').click()
  await expect(pane).toHaveAttribute('data-shown', 'true')
  // Over the stream: the stream keeps its width.
  expect(Math.abs((await box(page, 'stream-view')).width - s0.width)).toBeLessThan(2)
  await snap(page, 'tablet-open')
  await page.keyboard.press('Escape')
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await expect(page.getByTestId('stream-view')).toBeVisible() // Esc folded the pane, it did not go back

  await page.getByTestId('tasks-pane-toggle').click()
  await pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`).click()
  await expect(page.getByTestId('task-title')).toHaveText(/Fix the gauge reading/)
  await page.goBack()
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'false')
})

// The agent's Tasks pane sits between the agents list and the stream: [rail] | [agents] | [tasks] |
// [stream] | [terminal, shell, files when one is open]. Its width drags and is kept; it folds to a strip
// (its « button, the strip, ⇧T, the palette) and stays folded across reloads. A task opens in the
// agent's page (the pane stays); back returns to the stream. On a tablet too, while the stream keeps MIN_STREAM beside it; with no room
// (a side pane open on a portrait tablet) it is a strip that unfolds over the stream.
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
  // A working task's blue dot pulses like a working agent's dot.
  const dot = pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"] .v-dot`)
  await expect(dot).toHaveAttribute('data-status', 'working')
  await expect(dot).toHaveClass(/\bv-live\b/)
  expect(await dot.evaluate((e) => getComputedStyle(e).animationName)).toBe('v-pulse')
  // No side pane until the terminal, shell or files open; no tab strip (each pane shows on its own).
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)

  // The order, left to right.
  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(page.getByTestId('pane-tasks')).toHaveCount(0)
  const sb = await box(page, 'sidebar')
  const tp = await box(page, 'tasks-pane')
  const sv = await box(page, 'stream-view')
  const side = await box(page, 'side-terminal')
  expect(sb.x + sb.width).toBeLessThanOrEqual(tp.x + 1)
  expect(tp.x + tp.width).toBeLessThanOrEqual(sv.x + 1)
  expect(sv.x + sv.width).toBeLessThanOrEqual(side.x + 1)
  expect(sv.width).toBeGreaterThanOrEqual(380)
  await snap(page, 'desktop-terminal')
  await page.getByTestId('terminal-close').click()
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
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

  // A task opens in the agent's page (the Tasks pane stays); back returns to the stream.
  await pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`).click()
  await expect(page.getByTestId('agent-task-detail').getByTestId('column-title')).toHaveText(/Fix the gauge reading/)
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
  await page.goBack()
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', a.id)
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
})

test('tablet 900px: the Tasks pane is beside the stream, folds and unfolds as the person left it (kept across reloads)', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-layout', 'tablet')
  const pane = page.getByTestId('tasks-pane')
  await expect(pane).toHaveAttribute('data-shown', 'true')
  await expect(pane).not.toHaveAttribute('data-overlay', 'true')
  await expect(pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`)).toBeVisible()
  // A tablet's narrower default; the stream keeps its room beside it; the sidebar stays behind ☰.
  const t0 = await box(page, 'tasks-pane')
  expect(Math.abs(t0.width - 232)).toBeLessThan(4)
  const s0 = await box(page, 'stream-view')
  expect(s0.width).toBeGreaterThanOrEqual(380)
  expect(s0.x).toBeGreaterThanOrEqual(t0.x + t0.width - 1)
  await expect(page.getByTestId('sidebar')).toHaveCount(0)
  await snap(page, 'tablet-900')

  // A task opens beside the pane; the pane stays.
  await pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`).click()
  await expect(page.getByTestId('agent-task-detail').getByTestId('column-title')).toHaveText(/Fix the gauge reading/)
  await expect(pane).toHaveAttribute('data-shown', 'true')
  await page.goBack()
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', a.id)

  // Folded by the person: a strip, the stream wider; kept across a reload.
  await pane.getByTestId('tasks-pane-toggle').click()
  await expect(pane).toHaveAttribute('data-shown', 'false')
  expect((await box(page, 'stream-view')).width).toBeGreaterThan(900 - 56 - 34 - 10)
  await page.reload()
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'false')
  await expect(page.getByTestId('tasks-pane')).not.toHaveAttribute('data-overlay', 'true')
  // Unfolded again (the strip): kept too.
  await page.getByTestId('tasks-pane-toggle').click()
  await expect(pane).toHaveAttribute('data-shown', 'true')
  await page.reload()
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
  await expect(page.getByTestId('tasks-pane')).not.toHaveAttribute('data-overlay', 'true')
})

test('tablet 768px with the terminal open: no room, the Tasks pane is a strip that unfolds over the stream; a task or Esc folds it', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.setViewportSize({ width: 768, height: 1000 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  const pane = page.getByTestId('tasks-pane')
  // Portrait, nothing else open: beside the stream.
  await expect(pane).toHaveAttribute('data-shown', 'true')
  await expect(pane).not.toHaveAttribute('data-overlay', 'true')
  expect((await box(page, 'stream-view')).width).toBeGreaterThanOrEqual(380)
  await snap(page, 'tablet-768')

  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('side-terminal')).toBeVisible()
  await expect(pane).toHaveAttribute('data-overlay', 'true')
  await expect(pane).toHaveAttribute('data-shown', 'false')
  const s0 = await box(page, 'stream-view')
  expect(s0.width).toBeGreaterThanOrEqual(300)

  await page.getByTestId('tasks-pane-toggle').click()
  await expect(pane).toHaveAttribute('data-shown', 'true')
  // Over the stream: the stream keeps its width.
  expect(Math.abs((await box(page, 'stream-view')).width - s0.width)).toBeLessThan(2)
  await snap(page, 'tablet-768-terminal-open')
  await page.keyboard.press('Escape')
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await expect(page.getByTestId('stream-view')).toBeVisible() // Esc folded the pane, it did not go back

  await page.getByTestId('tasks-pane-toggle').click()
  await pane.locator(`[data-testid="agent-task"][data-task="${gauge.id}"]`).click()
  await expect(page.getByTestId('agent-task-detail').getByTestId('column-title')).toHaveText(/Fix the gauge reading/)
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await page.goBack()
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'false')

  // The terminal closed: room again, the pane is back beside the stream (the person never folded it).
  await page.getByTestId('terminal-toggle').click()
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
  await expect(pane).toHaveAttribute('data-shown', 'true')
  await expect(pane).not.toHaveAttribute('data-overlay', 'true')
})

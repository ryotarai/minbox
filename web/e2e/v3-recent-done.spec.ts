// The agent's Tasks list shows the tasks it just finished between OPEN TASKS and the folded DONE THIS
// WEEK: RECENTLY DONE (done in the last 3 hours, the newest 5), one muted line each (a small green
// check, no subtitle or progress), still opening and checkable as a column. Once its window passes, a
// task folds into DONE THIS WEEK (each done task is in one of the two only).
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures'
import { api, say, startAgent, taskNamed } from './v3'

const SHOTS = process.env.RECENT_DONE_SHOTS // a folder: screenshots (light and dark)
async function snap(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` })
  }
}

test('recently done tasks: between open and done this week, muted, and folded once their window passes', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  // Six tasks done one after another: the newest five are recent, the first folds.
  const done: { id: string }[] = []
  for (let i = 1; i <= 6; i++) {
    const t = await api(minbox, 'POST', '/api/v3/tasks', { project_id: a.project_id, title: `Finished chore ${i}`, session_id: a.id })
    await api(minbox, 'PATCH', `/api/v3/tasks/${t.id}`, { status: 'done' })
    done.push(t)
    await new Promise((r) => setTimeout(r, 15))
  }
  await page.clock.install()
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)

  const list = page.getByTestId('tasks-pane').getByTestId('agent-tasks')
  const recent = list.getByTestId('agent-tasks-recent')
  const folded = list.locator('details.v-donelist')
  const rowOf = (id: string) => list.locator(`[data-testid="agent-task"][data-task="${id}"]`)
  await expect(rowOf(gauge.id)).toBeVisible()
  await expect(recent).toContainText('RECENTLY DONE')
  await expect(recent.getByTestId('agent-task')).toHaveCount(5)
  // Newest first; the oldest of the six is in DONE THIS WEEK (folded), not in both.
  await expect(recent.getByTestId('agent-task').first()).toHaveAttribute('data-task', done[5].id)
  await expect(recent.locator(`[data-task="${done[0].id}"]`)).toHaveCount(0)
  await expect(folded.locator('summary')).toContainText('DONE THIS WEEK 1')
  await expect(rowOf(done[0].id)).toBeHidden()

  // Order: the open task, then RECENTLY DONE, then DONE THIS WEEK.
  const order = await list.evaluate((el) => {
    const open = el.querySelector('[data-testid="agent-task"]:not([data-recent-done])')!
    const rec = el.querySelector('[data-testid="agent-tasks-recent"]')!
    const det = el.querySelector('details.v-donelist')!
    const after = (x: Element, y: Element) => !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING)
    return after(open, rec) && after(rec, det)
  })
  expect(order).toBe(true)

  // Muted: dimmer title color, smaller text, one line, no subtitle or progress; shorter than the open card.
  const work = rowOf(gauge.id)
  const r1 = rowOf(done[5].id)
  const look = (l: typeof work) => l.locator('.v-a').evaluate((e) => ({ color: getComputedStyle(e).color, size: parseFloat(getComputedStyle(e).fontSize) }))
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    const [w, r] = [await look(work), await look(r1)]
    expect(r.color).not.toBe(w.color)
    expect(r.size).toBeLessThan(w.size)
  }
  await expect(r1.getByTestId('task-standing')).toHaveCount(0)
  await expect(r1.getByTestId('progress')).toHaveCount(0)
  await expect(r1.locator('.v-rd-check')).toBeVisible()
  expect((await r1.boundingBox())!.height).toBeLessThan((await work.boundingBox())!.height)
  await snap(page, 'recent-done')

  // Still a task: its row (no checkbox) opens it.
  await expect(list.locator('input[type="checkbox"]')).toHaveCount(0)
  await r1.click()
  await expect(r1).toHaveAttribute('aria-current', 'true')
  await r1.click()

  // Three hours later they all fold into DONE THIS WEEK.
  await page.clock.fastForward('03:01:00')
  await expect(recent).toHaveCount(0)
  await expect(folded.locator('summary')).toContainText('DONE THIS WEEK 6')
  await expect(rowOf(gauge.id)).toBeVisible()
})

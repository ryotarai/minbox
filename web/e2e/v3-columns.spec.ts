// Columns (#v=columns): the tasks checked in its list side by side, each with its messages and a reply
// box to the agent last active on it. "All" is every open task (new ones too); the choice survives a
// reload. A phone shows one column at a time, with a tab per checked task.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

/** COLUMNS_SHOTS=<dir>: screenshots of the view (for review). */
async function snap(page: Page, name: string) {
  const dir = process.env.COLUMNS_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

const col = (page: Page, id: string) => page.locator(`[data-testid="task-column"][data-task="${id}"]`)
const pick = (page: Page, id: string) => page.locator(`[data-testid="columns-pick"][data-task="${id}"] input`)

test('columns: checkboxes and All pick the tasks; each column has its messages; a reply goes to its agent about its task; kept across a reload', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  await say(minbox, a, 'please fix the gauge reading')
  const t1 = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, b, 'please update the login screen copy')
  const t2 = await taskNamed(minbox, /Update the login screen copy/)
  await agentReply(minbox, b, /created a task/)

  // From the sidebar: nothing checked yet.
  await page.goto(minbox.url)
  await page.getByTestId('nav-columns').click()
  await expect(page.getByTestId('columns-view')).toBeVisible()
  await expect(page).toHaveURL(/v=columns/)
  await expect(page.getByTestId('columns-empty')).toBeVisible()
  await expect(page.getByTestId('task-column')).toHaveCount(0)

  // All: every open task, side by side, each with its own messages and reply box.
  await page.getByTestId('columns-all').check()
  await expect(page.getByTestId('task-column')).toHaveCount(2)
  await expect(col(page, t1.id).getByTestId('column-title')).toHaveText('Fix the gauge reading')
  await expect(col(page, t1.id).getByTestId('v3-message').filter({ hasText: 'please fix the gauge reading' })).toBeVisible()
  await expect(col(page, t2.id).getByTestId('v3-message').filter({ hasText: 'please update the login screen copy' })).toBeVisible()
  await expect(col(page, t1.id).getByTestId('task-composer')).toBeVisible()
  await expect(col(page, t2.id).getByTestId('composer-to')).toHaveValue(b.id)
  // Equal widths, side by side.
  const [w1, w2] = await Promise.all([col(page, t1.id).boundingBox(), col(page, t2.id).boundingBox()])
  expect(Math.abs(w1!.width - w2!.width)).toBeLessThan(2)
  expect(w2!.x).toBeGreaterThan(w1!.x + w1!.width - 2)
  await snap(page, 'columns-desktop')

  // Unchecking one: All turns partial, its column goes.
  await pick(page, t1.id).uncheck()
  await expect(page.getByTestId('columns-all')).toHaveAttribute('data-state', 'some')
  await expect(page.getByTestId('task-column')).toHaveCount(1)
  await expect(col(page, t2.id)).toBeVisible()

  // The choice is kept across a reload.
  await page.reload()
  await expect(page.getByTestId('task-column')).toHaveCount(1)
  await expect(col(page, t2.id)).toBeVisible()
  await expect(pick(page, t1.id)).not.toBeChecked()
  await expect(page.getByTestId('columns-all')).toHaveAttribute('data-state', 'some')

  // A reply from a column: to that task's agent, about that task; the column shows it (live).
  const box = col(page, t2.id).getByTestId('composer-text')
  await box.fill('use the shorter wording')
  await col(page, t2.id).getByTestId('composer-send').click()
  await expect(col(page, t2.id).getByTestId('v3-message').filter({ hasText: 'use the shorter wording' })).toBeVisible()
  await expect
    .poll(async () => {
      const s = await api(minbox, 'GET', `/api/v3/sessions/${b.id}/stream`)
      const m = s.messages.find((x: any) => x.author === 'user' && x.words === 'use the shorter wording')
      return m ? m.tasks.map((x: any) => x.task_id) : null
    })
    .toEqual([t2.id])
  const sa = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  expect(sa.messages.some((x: any) => x.words === 'use the shorter wording')).toBe(false)
  // The agent's answer arrives in the column (SSE).
  await expect(col(page, t2.id).getByTestId('v3-message').filter({ hasText: /Noted for/ })).toBeVisible()

  // Checking the last one makes it All again; then a new open task comes in by itself.
  await pick(page, t1.id).check()
  await expect(page.getByTestId('columns-all')).toHaveAttribute('data-state', 'on')
  await expect(page.getByTestId('task-column')).toHaveCount(2)
  const c = await startAgent(minbox, 'ops')
  await say(minbox, c, 'please migrate the build cache')
  const t3 = await taskNamed(minbox, /Migrate the build cache/)
  await expect(col(page, t3.id)).toBeVisible()
  await expect(page.getByTestId('task-column')).toHaveCount(3)

  // ✕ on a column unchecks it; the title opens the full task view.
  await col(page, t3.id).getByTestId('column-remove').click()
  await expect(col(page, t3.id)).toHaveCount(0)
  await expect(page.getByTestId('columns-all')).toHaveAttribute('data-state', 'some')
  await col(page, t1.id).getByTestId('column-open').click()
  await expect(page.getByTestId('task-view')).toHaveAttribute('data-task', t1.id)
  // All off clears them.
  await page.goBack()
  await page.getByTestId('columns-all').click()
  await expect(page.getByTestId('columns-all')).toHaveAttribute('data-state', 'on')
  await page.getByTestId('columns-all').click()
  await expect(page.getByTestId('task-column')).toHaveCount(0)
})

test('columns: many tasks scroll sideways at a minimum width; g c and the palette open the view', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  for (const t of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']) await api(minbox, 'POST', '/api/v3/tasks', { title: 'Task ' + t, session_id: a.id })
  await page.goto(minbox.url)
  await expect(page.getByTestId('board')).toBeVisible()
  await page.keyboard.press('g')
  await page.keyboard.press('c')
  await expect(page.getByTestId('columns-view')).toBeVisible()
  await page.getByTestId('columns-all').check()
  await expect(page.getByTestId('task-column')).toHaveCount(6)
  const strip = page.getByTestId('columns')
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  const w = (await page.getByTestId('task-column').first().boundingBox())!.width
  expect(w).toBeGreaterThanOrEqual(318)
  // The page itself does not scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  // Hide the list: more room for the columns.
  await page.getByTestId('columns-list-toggle').click()
  await expect(page.getByTestId('columns-picker')).toHaveCount(0)
  await snap(page, 'columns-many')
  await page.getByTestId('columns-list-toggle').click()
  // The palette.
  await page.getByTestId('nav-board').click()
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('columns')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('columns-view')).toBeVisible()
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('columns on a phone: one column at a time, tabs between the checked tasks, the list behind Tasks', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    const b = await startAgent(minbox, 'web')
    await say(minbox, a, 'please fix the gauge reading')
    const t1 = await taskNamed(minbox, /Fix the gauge reading/)
    await say(minbox, b, 'please update the login screen copy')
    const t2 = await taskNamed(minbox, /Update the login screen copy/)
    await page.goto(minbox.url)
    await page.getByTestId('open-columns').tap()
    await expect(page.getByTestId('columns-picker')).toBeVisible()
    await page.getByTestId('columns-all').tap()
    await expect(page.getByTestId('columns-tabs')).toBeVisible()
    await expect(page.getByTestId('task-column')).toHaveCount(1)
    await expect(col(page, t1.id)).toBeVisible()
    await expect(col(page, t1.id).getByTestId('task-composer')).toBeVisible()
    await page.locator(`[data-testid="columns-tab"][data-task="${t2.id}"]`).tap()
    await expect(col(page, t2.id)).toBeVisible()
    await expect(col(page, t2.id).getByTestId('v3-message').filter({ hasText: 'please update the login screen copy' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await snap(page, 'columns-phone')
    // Tasks: back to the list.
    await page.getByTestId('columns-list-toggle').tap()
    await expect(page.getByTestId('columns-picker')).toBeVisible()
  })
})

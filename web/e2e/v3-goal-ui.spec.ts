// The person sets goals from the UI: the Board's "New goal" (and ⇧N's Message / Goal switch, ⌘K › New
// goal) with criteria one per line, its agent and optionally its run; the goal's "Done when" list is
// edited in place (add, edit, delete, tick; all ticked: done); a task becomes a goal from its ⋯ menu;
// the create flow fits a phone.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { api, startAgent } from './v3'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/** GOAL_UI_SHOTS=<dir>: screenshots of the flow for review. */
async function snap(page: Page, name: string) {
  const dir = process.env.GOAL_UI_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

const criteriaTexts = (page: Page) => page.getByTestId('criterion').allInnerTexts()

test('New goal from the Board: criteria one per line; it shows in GOALS; criteria edited inline; all ticked is done', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(minbox.url)
  await page.getByTestId('new-goal').click()
  const dlg = page.getByTestId('new-goal-dialog')
  await expect(dlg).toBeVisible()
  await expect(page.getByTestId('new-goal-title')).toBeFocused()
  await page.getByTestId('new-goal-title').fill('Checkout is fast')
  await page.getByTestId('new-goal-title').press('Enter') // on to the criteria
  await expect(page.getByTestId('new-goal-criteria')).toBeFocused()
  await page.keyboard.type('- p95 under 300 ms\n- No N+1 queries\n\nLoad test passes')
  await expect(page.getByTestId('new-goal-agent')).toHaveValue(a.id)
  await expect(page.getByTestId('new-goal-run')).not.toBeChecked()
  await snap(page, 'create-goal')
  await page.getByTestId('new-goal-create').click()
  await expect(dlg).toHaveCount(0)

  // It opens: the goal's card with its criteria (the list markers dropped).
  await expect(page.getByTestId('task-title')).toHaveText('Checkout is fast')
  expect(await criteriaTexts(page)).toEqual(['p95 under 300 ms', 'No N+1 queries', 'Load test passes'])

  // Add (↵ adds and keeps the field), edit by double-click and by the pencil, delete.
  const add = page.getByTestId('criterion-add')
  await add.fill('Dashboards updated')
  await add.press('Enter')
  await expect(add).toHaveValue('')
  await expect(add).toBeFocused()
  await expect(page.getByTestId('criterion')).toHaveCount(4)
  await page.getByTestId('criterion').nth(0).dblclick()
  const edit = page.getByTestId('criterion-input')
  await expect(edit).toBeFocused()
  await edit.fill('p95 under 250 ms')
  await edit.press('Enter')
  await page.getByTestId('criterion-row').nth(1).hover()
  await page.getByTestId('criterion-row').nth(1).getByTestId('criterion-edit').click()
  await page.getByTestId('criterion-input').fill('No N+1 queries on checkout')
  await page.getByTestId('criterion-input').press('Enter')
  await page.getByTestId('criterion-row').nth(2).hover()
  await page.getByTestId('criterion-row').nth(2).getByTestId('criterion-delete').click()
  await expect(page.getByTestId('criterion')).toHaveCount(3)
  await expect.poll(() => criteriaTexts(page)).toEqual(['p95 under 250 ms', 'No N+1 queries on checkout', 'Dashboards updated'])
  // Saved: the server has the same list, nothing ticked (a double-click edits, it does not tick).
  const id = (await page.getByTestId('task-column').getAttribute('data-task'))!
  await expect
    .poll(async () => (await api(minbox, 'GET', `/api/v3/tasks/${id}`)).task.criteria)
    .toEqual([
      { text: 'p95 under 250 ms', done: false },
      { text: 'No N+1 queries on checkout', done: false },
      { text: 'Dashboards updated', done: false },
    ])
  await page.getByTestId('criterion-row').nth(0).hover()
  await snap(page, 'criteria-editing')

  // On the Board: under GOALS.
  await page.goto(minbox.url)
  const row = page.getByTestId('group-goals').locator(`[data-testid="task-row"][data-task="${id}"]`)
  await expect(row).toContainText('Checkout is fast')
  await expect(row).toHaveAttribute('data-kind', 'goal')

  // Ticking every criterion makes it done (it leaves GOALS).
  await row.locator('.v-line').click()
  await expect(page.getByTestId('task-title')).toHaveText('Checkout is fast')
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('criterion').nth(i).click()
    await expect(page.getByTestId('criterion').nth(i)).toHaveAttribute('aria-pressed', 'true')
  }
  await expect(page.getByTestId('task-status')).toHaveValue('done')
  const d = await api(minbox, 'GET', `/api/v3/tasks/${id}`)
  expect(d.task.status).toBe('done')
})

test('⇧N switches to Goal and ⌘K › New goal; the run can start at once with its turns', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(minbox.url)
  await expect(page.getByTestId('board')).toBeVisible()
  await page.keyboard.press('Shift+N')
  await expect(page.getByTestId('new-message-dialog')).toBeVisible()
  await page.getByTestId('new-mode-goal').click()
  await expect(page.getByTestId('new-goal-dialog')).toBeVisible()
  await page.getByTestId('new-mode-message').click()
  await expect(page.getByTestId('new-message-dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('new-message-dialog')).toHaveCount(0)

  await page.keyboard.press(`${MOD}+k`)
  await page.getByTestId('palette-input').fill('new goal')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('new-goal-dialog')).toBeVisible()
  await page.getByTestId('new-goal-title').fill('Flaky tests fixed')
  await page.getByTestId('new-goal-criteria').fill('checkout spec passes 20 runs')
  await page.getByTestId('new-goal-run').check()
  await expect(page.getByTestId('new-goal-turns')).toHaveValue('20')
  await page.getByTestId('new-goal-turns').fill('5')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(page.getByTestId('new-goal-dialog')).toHaveCount(0)
  await expect(page.getByTestId('task-title')).toHaveText('Flaky tests fixed')
  const id = (await page.getByTestId('task-column').getAttribute('data-task'))!
  const d = await api(minbox, 'GET', `/api/v3/tasks/${id}`)
  expect(d.task.kind).toBe('goal')
  expect(d.task.auto.session_id).toBe(a.id)
  expect(d.task.auto.max_turns).toBe(5)
  expect(['running', 'stopped']).toContain(d.task.auto.state) // the fake agent may meet it at once
  expect(d.task.agents.map((x: any) => x.session_id)).toContain(a.id)
})

test('a task becomes a goal from its ⋯ menu; its criteria are added on the goal', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const t = await api(minbox, 'POST', '/api/v3/tasks', { project_id: a.project_id, title: 'Speed up CI', session_id: a.id })
  await page.goto(minbox.url)
  const row = page.locator(`[data-testid="task-row"][data-task="${t.id}"]`)
  await expect(row).toHaveAttribute('data-kind', 'task')
  await row.hover()
  await row.getByTestId('task-row-more').click()
  await page.getByTestId('menu-make-goal').click()
  const goalRow = page.getByTestId('group-goals').locator(`[data-testid="task-row"][data-task="${t.id}"]`)
  await expect(goalRow).toHaveAttribute('data-kind', 'goal')
  // A goal's menu does not offer it again.
  await goalRow.hover()
  await goalRow.getByTestId('task-row-more').click()
  await expect(page.getByTestId('menu-rename-task')).toBeVisible()
  await expect(page.getByTestId('menu-make-goal')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // On the goal: no criteria yet, and the field to add them.
  await goalRow.locator('.v-line').click()
  await expect(page.getByTestId('criteria-empty')).toBeVisible()
  await page.getByTestId('criterion-add').fill('CI under 10 minutes')
  await page.getByTestId('criterion-add').press('Enter')
  await expect(page.getByTestId('criterion')).toHaveText(['CI under 10 minutes'])
  await expect(page.getByTestId('criteria-empty')).toHaveCount(0)
  await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)).task.criteria).toEqual([{ text: 'CI under 10 minutes', done: false }])
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the New goal dialog fits a phone, no horizontal scroll', async ({ page, minbox }) => {
    await startAgent(minbox, 'api')
    await page.goto(minbox.url)
    await page.getByTestId('new-goal').tap()
    const dlg = page.getByTestId('new-goal-dialog').locator('.v-dialog')
    await expect(dlg).toBeVisible()
    await page.getByTestId('new-goal-title').fill('Release 2.0 shipped')
    await page.getByTestId('new-goal-criteria').fill('Changelog written\nTag pushed\nBinaries uploaded')
    await page.getByTestId('new-goal-run').check()
    const box = (await dlg.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
    for (const id of ['new-goal-title', 'new-goal-criteria', 'new-goal-agent', 'new-goal-turns', 'new-goal-create']) {
      const b = (await page.getByTestId(id).boundingBox())!
      expect(b.x + b.width, id).toBeLessThanOrEqual(390)
      expect(b.y + b.height, id).toBeLessThanOrEqual(844)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await snap(page, 'phone-create-goal')
    await page.getByTestId('new-goal-create').tap()
    await expect(page.getByTestId('task-title')).toHaveText('Release 2.0 shipped')
    await expect(page.getByTestId('criterion')).toHaveCount(3)
    await snap(page, 'phone-goal')
  })
})

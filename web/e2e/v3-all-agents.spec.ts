// All agents, at the top of the agents list: laid out as an agent's page. The Tasks pane lists every
// agent's tasks (the agent list's sections: OPEN TASKS, RECENTLY DONE, DONE THIS WEEK; unread bold),
// each row with a small badge naming its agent. Beside it: "Select a task" (no message box) until a
// task is picked; then that task as in an agent's page (card, checklist, messages, its message box
// to the task's agent), staying in All agents (#v=alltasks&k=…). The task again, back or Esc: "Select a
// task" again. An archived agent's tasks are left out (it is not in the list either).
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { api, startAgent, type Agent } from './v3'

/** ALL_AGENTS_SHOTS=<dir>: screenshots (for review). */
async function shot(page: Page, name: string) {
  const dir = process.env.ALL_AGENTS_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

async function setup(minbox: Parameters<typeof startAgent>[0]) {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  const old = await startAgent(minbox, 'old')
  const task = (ag: Agent, title: string) => api(minbox, 'POST', '/api/v3/tasks', { project_id: ag.project_id, title, session_id: ag.id })
  const apiOpen = await task(a, 'Fix the gauge reading')
  const webOpen = await task(b, 'Restyle the login page')
  await api(minbox, 'PATCH', `/api/v3/tasks/${webOpen.id}`, { steps: [{ text: 'Pick the colors', done: true }, { text: 'Restyle the form', done: false }] })
  const webDone = await task(b, 'Ship the footer')
  await api(minbox, 'PATCH', `/api/v3/tasks/${webDone.id}`, { status: 'done' })
  const oldOpen = await task(old, 'Old agent chore')
  await api(minbox, 'POST', `/api/sessions/${old.id}/stop`)
  await expect.poll(async () => (await api(minbox, 'GET', '/api/sessions')).find((x: any) => x.id === old.id)?.status, { timeout: 15_000 }).toBe('ended')
  await api(minbox, 'POST', `/api/sessions/${old.id}/archive`)
  return { a, b, apiOpen, webOpen, webDone, oldOpen }
}

test('All agents: the agent page’s panes; every agent’s tasks in the Tasks pane; a task shows beside it and its reply reaches its agent', async ({ page, minbox }) => {
  const { a, b, apiOpen, webOpen, webDone, oldOpen } = await setup(minbox)
  await page.setViewportSize({ width: 1400, height: 860 })
  await page.goto(minbox.url + '/')

  // At the top of the agents list, styled like its rows.
  const agents = page.getByTestId('sidebar').getByTestId('agents')
  const row = agents.getByTestId('all-agents-row')
  await expect(row).toBeVisible()
  await expect(agents.locator('button').first()).toHaveAttribute('data-testid', 'all-agents-row')
  await expect(row).toHaveClass(/\bv-ag\b/)
  await expect(row).toContainText('All agents')
  await expect(row).toContainText('2 open tasks')
  await row.click()
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(row).toHaveClass(/\bsel\b/)
  await expect(row).toHaveAttribute('aria-current', 'true')

  // The panes of an agent's page: the Tasks pane, then the main pane with its header.
  const pane = page.getByTestId('tasks-pane')
  await expect(pane).toHaveAttribute('data-shown', 'true')
  const view = page.locator('.v-main').getByTestId('all-agents-view')
  await expect(view.getByTestId('all-agents-title')).toHaveText('All agents')
  const pb = (await pane.boundingBox())!
  const vb = (await view.boundingBox())!
  expect(pb.x + pb.width).toBeLessThanOrEqual(vb.x + 2)
  // Nothing picked: "Select a task", and no message box (there is no one agent to write to).
  await expect(view.getByTestId('all-agents-empty')).toHaveText('Select a task')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('task-composer')).toHaveCount(0)
  // No agent-only controls in the header.
  await expect(view.getByTestId('terminal-toggle')).toHaveCount(0)

  const list = pane.getByTestId('agent-tasks')
  const rowOf = (id: string) => list.locator(`[data-testid="agent-task"][data-task="${id}"]`)
  await expect(list.locator('.v-sec').first()).toContainText('OPEN TASKS 2')
  await expect(rowOf(apiOpen.id)).toBeVisible()
  await expect(rowOf(webOpen.id)).toBeVisible()
  await expect(rowOf(oldOpen.id)).toHaveCount(0)
  await expect(list.getByTestId('agent-tasks-recent').locator(`[data-task="${webDone.id}"]`)).toBeVisible()
  // Each row names its agent; no checkboxes.
  await expect(rowOf(apiOpen.id).getByTestId('task-agent-badge')).toHaveText(a.name)
  await expect(rowOf(webOpen.id).getByTestId('task-agent-badge')).toHaveText(b.name)
  await expect(rowOf(webDone.id).getByTestId('task-agent-badge')).toHaveText(b.name)
  await expect(list.locator('input[type="checkbox"]')).toHaveCount(0)
  const look = await rowOf(apiOpen.id).getByTestId('task-agent-badge').evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), bg: getComputedStyle(e).backgroundColor }))
  expect(look.size).toBeLessThan(12)
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)')
  await shot(page, 'all-agents-desktop')

  // A task: shown beside the pane, as in an agent's page, staying in All agents.
  await rowOf(webOpen.id).click()
  await expect(page).toHaveURL(new RegExp(`#v=alltasks&k=${webOpen.id}$`))
  await expect(rowOf(webOpen.id)).toHaveAttribute('aria-current', 'true')
  await expect(row).toHaveClass(/\bsel\b/)
  const detail = view.getByTestId('agent-task-detail')
  await expect(detail.getByTestId('task-card')).toBeVisible()
  await expect(detail.getByTestId('task-title')).toHaveText('Restyle the login page')
  await expect(detail.getByTestId('task-checklist')).toContainText('Restyle the form')
  await expect(view.getByTestId('all-agents-empty')).toHaveCount(0)
  // The reply goes to the task's agent, about the task.
  const box = detail.getByTestId('task-composer')
  await expect(box.locator('.v-to')).toContainText(b.name)
  await box.getByTestId('composer-text').fill('please use the brand blue')
  await box.getByTestId('composer-send').click()
  await expect(detail.locator('[data-testid="v3-message"][data-author="user"]').filter({ hasText: 'please use the brand blue' })).toHaveCount(1)
  await expect
    .poll(async () => {
      const s = await api(minbox, 'GET', `/api/v3/sessions/${b.id}/stream`)
      const m = s.messages.find((x: any) => x.author === 'user' && x.words === 'please use the brand blue')
      return m ? m.tasks.map((t: any) => t.task_id) : null
    })
    .toEqual([webOpen.id])
  const other = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  expect(other.messages.some((x: any) => x.words === 'please use the brand blue')).toBe(false)
  await shot(page, 'all-agents-desktop-task')

  // Another task replaces it; the shown one again: "Select a task" again.
  await rowOf(apiOpen.id).click()
  await expect(page).toHaveURL(new RegExp(`#v=alltasks&k=${apiOpen.id}$`))
  await expect(detail.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await rowOf(apiOpen.id).click()
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(view.getByTestId('all-agents-empty')).toBeVisible()
  await expect(page.getByTestId('task-composer')).toHaveCount(0)

  // Esc from a picked task: back to "Select a task".
  await rowOf(webOpen.id).click()
  await expect(page).toHaveURL(new RegExp(`#v=alltasks&k=${webOpen.id}$`))
  await page.locator('body').click({ position: { x: 700, y: 10 } })
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(view.getByTestId('all-agents-empty')).toBeVisible()

  // ⇧T folds the pane to its strip, as in an agent's page.
  await page.keyboard.press('Shift+T')
  await expect(pane).toHaveAttribute('data-shown', 'false')
  await page.keyboard.press('Shift+T')
  await expect(pane).toHaveAttribute('data-shown', 'true')
})

test('All agents: an unread task is bold there too', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await api(minbox, 'POST', `/api/v3/sessions/${a.id}/messages`, { words: 'please fix the gauge reading' })
  let t: any = null
  await expect
    .poll(
      async () => {
        const bd = await api(minbox, 'GET', '/api/v3/board')
        t = bd.tasks.find((x: any) => /Fix the gauge reading/.test(x.title) && x.unread > 0)
        return !!t
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  await page.setViewportSize({ width: 1400, height: 860 })
  await page.goto(minbox.url + '/#v=alltasks')
  const title = page.getByTestId('tasks-pane').locator(`[data-testid="agent-task"][data-task="${t.id}"] .v-a`)
  await expect(title).toHaveAttribute('data-unread', 'true')
  await expect(title).toHaveClass(/v-unr-t/)
})

test('All agents on a phone: the agent page’s pattern (Tasks N › sheet); a task shows in All agents', async ({ page, minbox }) => {
  const { b, apiOpen, webOpen } = await setup(minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#v=agents')
  const row = page.getByTestId('agents-view').getByTestId('all-agents-row')
  await expect(row).toBeVisible()
  await row.click()
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(page.getByTestId('tab-agents')).toHaveClass(/\bon\b/)
  const view = page.getByTestId('all-agents-view')
  await expect(view.getByTestId('all-agents-empty')).toContainText('Select a task')
  await expect(page.getByTestId('composer')).toHaveCount(0)
  // As in an agent's page: "Tasks N ›" opens the tasks as a sheet.
  const open = view.getByTestId('agent-sheet-open')
  await expect(open).toContainText('Tasks 2')
  await open.click()
  await expect(page).toHaveURL(/#v=alltasks&tab=tasks$/)
  const sheet = page.getByTestId('agent-side')
  const rowOf = (id: string) => sheet.locator(`[data-testid="agent-task"][data-task="${id}"]`)
  await expect(rowOf(apiOpen.id).getByTestId('task-agent-badge')).toBeVisible()
  await expect(rowOf(webOpen.id).getByTestId('task-agent-badge')).toHaveText(b.name)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const box = (await rowOf(webOpen.id).boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await shot(page, 'all-agents-phone')
  await rowOf(webOpen.id).click()
  await expect(page).toHaveURL(new RegExp(`#v=alltasks&k=${webOpen.id}$`))
  await expect(page.getByTestId('agent-side')).toHaveCount(0)
  await expect(view.getByTestId('task-title')).toHaveText('Restyle the login page')
  await expect(view.getByTestId('task-composer')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await shot(page, 'all-agents-phone-task')
  // Back: the sheet, then All agents' "Select a task".
  await page.getByTestId('back').first().click()
  await expect(page).toHaveURL(/#v=alltasks&tab=tasks$/)
  await page.getByTestId('agent-sheet-close').click()
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(view.getByTestId('all-agents-empty')).toBeVisible()
})

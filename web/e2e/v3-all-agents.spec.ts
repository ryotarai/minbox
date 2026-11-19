// All agents, at the top of the agents list: one task list of every agent of the project (the agent
// list's sections: OPEN TASKS, RECENTLY DONE, DONE THIS WEEK; unread bold), each row with a small badge
// naming its agent (not in an agent's own list). A task opens in its agent's page, selected there, and
// back returns to All agents. An archived agent's tasks are left out (it is not in the list either).
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
  const webDone = await task(b, 'Ship the footer')
  await api(minbox, 'PATCH', `/api/v3/tasks/${webDone.id}`, { status: 'done' })
  const oldOpen = await task(old, 'Old agent chore')
  await api(minbox, 'POST', `/api/sessions/${old.id}/stop`)
  await expect.poll(async () => (await api(minbox, 'GET', '/api/sessions')).find((x: any) => x.id === old.id)?.status, { timeout: 15_000 }).toBe('ended')
  await api(minbox, 'POST', `/api/sessions/${old.id}/archive`)
  return { a, b, apiOpen, webOpen, webDone, oldOpen }
}

test('All agents: every agent’s tasks in one list, each naming its agent; a task opens in its agent’s page and back returns', async ({ page, minbox }) => {
  const { a, b, apiOpen, webOpen, webDone, oldOpen } = await setup(minbox)
  await page.setViewportSize({ width: 1400, height: 860 })
  await page.goto(minbox.url + '/')

  // At the top of the agents list, styled like its rows.
  const agents = page.getByTestId('sidebar').getByTestId('agents')
  const row = agents.getByTestId('all-agents-row')
  await expect(row).toBeVisible()
  const firstRow = agents.locator('button').first()
  await expect(firstRow).toHaveAttribute('data-testid', 'all-agents-row')
  await expect(row).toHaveClass(/\bv-ag\b/)
  await expect(row).toContainText('All agents')
  await expect(row).toContainText('2 open tasks')
  await expect(row).not.toHaveClass(/\bsel\b/)
  await row.click()
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(row).toHaveClass(/\bsel\b/)
  await expect(row).toHaveAttribute('aria-current', 'true')

  const view = page.getByTestId('all-agents-view')
  await expect(view.locator('h1')).toHaveText('All agents')
  const list = view.getByTestId('agent-tasks')
  const rowOf = (id: string) => list.locator(`[data-testid="agent-task"][data-task="${id}"]`)
  await expect(list.locator('.v-sec').first()).toContainText('OPEN TASKS 2')
  await expect(rowOf(apiOpen.id)).toBeVisible()
  await expect(rowOf(webOpen.id)).toBeVisible()
  // The archived agent's task is left out.
  await expect(rowOf(oldOpen.id)).toHaveCount(0)
  // Just done: RECENTLY DONE, as in an agent's list.
  await expect(list.getByTestId('agent-tasks-recent').locator(`[data-task="${webDone.id}"]`)).toBeVisible()

  // Each row names its agent.
  await expect(rowOf(apiOpen.id).getByTestId('task-agent-badge')).toHaveText(a.name)
  await expect(rowOf(webOpen.id).getByTestId('task-agent-badge')).toHaveText(b.name)
  await expect(rowOf(webDone.id).getByTestId('task-agent-badge')).toHaveText(b.name)
  // Quiet: small text on the chip background.
  const look = await rowOf(apiOpen.id).getByTestId('task-agent-badge').evaluate((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), bg: getComputedStyle(e).backgroundColor }))
  expect(look.size).toBeLessThan(12)
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)')
  await shot(page, 'all-agents-desktop')

  // A task opens in its agent's page, selected there (the checklist card).
  await rowOf(webOpen.id).click()
  await expect(page).toHaveURL(new RegExp(`#s=${b.id}&v=agent&k=${webOpen.id}$`))
  await expect(page.getByTestId('task-card')).toBeVisible()
  await expect(page.getByTestId('task-title')).toHaveText('Restyle the login page')
  const own = page.getByTestId('tasks-pane').getByTestId('agent-tasks')
  await expect(own.locator(`[data-testid="agent-task"][data-task="${webOpen.id}"]`)).toHaveAttribute('aria-current', 'true')
  // No badge in the agent's own list.
  await expect(own.getByTestId('task-agent-badge')).toHaveCount(0)
  await expect(row).not.toHaveClass(/\bsel\b/)
  // Deselecting it there goes back to the stream.
  await own.locator(`[data-testid="agent-task"][data-task="${webOpen.id}"]`).click()
  await expect(page).toHaveURL(new RegExp(`#s=${b.id}&v=agent$`))

  // Back: All agents again.
  await page.goBack()
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(view).toBeVisible()
  await expect(row).toHaveClass(/\bsel\b/)
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
  const title = page.getByTestId('all-agents-view').locator(`[data-testid="agent-task"][data-task="${t.id}"] .v-a`)
  await expect(title).toHaveAttribute('data-unread', 'true')
  await expect(title).toHaveClass(/v-unr-t/)
})

test('All agents on a phone: from the Agents tab, the list fits the width, a task opens in its agent', async ({ page, minbox }) => {
  const { b, apiOpen, webOpen } = await setup(minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#v=agents')
  const row = page.getByTestId('agents-view').getByTestId('all-agents-row')
  await expect(row).toBeVisible()
  await row.click()
  await expect(page).toHaveURL(/#v=alltasks$/)
  await expect(page.getByTestId('tab-agents')).toHaveClass(/\bon\b/)
  const view = page.getByTestId('all-agents-view')
  const rowOf = (id: string) => view.locator(`[data-testid="agent-task"][data-task="${id}"]`)
  await expect(rowOf(apiOpen.id).getByTestId('task-agent-badge')).toBeVisible()
  await expect(rowOf(webOpen.id).getByTestId('task-agent-badge')).toHaveText(b.name)
  // No horizontal scroll; each row within the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const box = (await rowOf(webOpen.id).boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await shot(page, 'all-agents-phone')
  await rowOf(webOpen.id).click()
  await expect(page).toHaveURL(new RegExp(`#s=${b.id}&v=agent&k=${webOpen.id}$`))
  await expect(page.getByTestId('task-title')).toHaveText('Restyle the login page')
  // Back: All agents again.
  await page.getByTestId('back').first().click()
  await expect(page).toHaveURL(/#v=alltasks$/)
})

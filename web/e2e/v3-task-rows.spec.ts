// An agent's Tasks pane: a plain list of rows, no checkboxes. A row shows that one task in place of the
// stream (the row selected; the same row again, or ‹, back to the stream). The multi-select task columns
// (checkboxes, "All", "N checked · Clear", the pane's own message box) are gone: an old #v=columns link
// lands on the Board, and columns once checked in this browser are ignored (and forgotten).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

/** TASK_ROWS_SHOTS=<dir>: screenshots of the view (for review). */
async function snap(page: Page, name: string) {
  const dir = process.env.TASK_ROWS_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

const conv = (page: Page) => page.getByTestId('stream-view').getByTestId('conv-bar')

test('desktop: task rows have no checkbox; an old columns choice is ignored and forgotten; one task opens in place', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const t1 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Fix the gauge reading', session_id: a.id })
  const t2 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Update the login screen copy', session_id: a.id })
  await api(minbox, 'PATCH', `/api/v3/tasks/${t2.id}`, { status: 'done' })
  await page.setViewportSize({ width: 1600, height: 900 })
  // Columns checked in this browser before they were removed.
  await page.goto(minbox.url)
  await page.evaluate(([s, t]) => localStorage.setItem('minbox:v3-columns:' + s, JSON.stringify({ all: true, ids: [t] })), [a.id, t1.id])
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await page.reload()
  const pane = page.getByTestId('tasks-pane')
  await expect(pane).toHaveAttribute('data-shown', 'true')
  await expect(pane.locator(`[data-testid="agent-task"][data-task="${t1.id}"]`)).toBeVisible()
  await expect(pane.locator(`[data-testid="agent-task"][data-task="${t2.id}"]`)).toBeVisible()
  // No checkbox anywhere in the pane (rows, "All", the header), no "checked" count, no pane message box.
  await expect(pane.locator('input[type="checkbox"]')).toHaveCount(0)
  await expect(pane.getByRole('checkbox')).toHaveCount(0)
  await expect(pane).not.toContainText('checked')
  await expect(page.getByTestId('tasks-composer')).toHaveCount(0)
  // The stream, not columns.
  await expect(conv(page)).toBeVisible()
  await expect(page.getByTestId('task-column')).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('minbox:v3-columns:')))).toEqual([])
  await snap(page, 'tasks-pane-desktop')
  // One task: opens in place with the one box (two send buttons); the row again closes it.
  await pane.locator(`[data-testid="agent-task"][data-task="${t1.id}"]`).click()
  const detail = page.getByTestId('agent-task-detail')
  await expect(detail.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(page.getByTestId('composer-text')).toHaveCount(1)
  await expect(detail.getByTestId('composer-send')).toBeVisible()
  await expect(detail.getByTestId('composer-send-untagged')).toBeVisible()
  await expect(pane.locator('input[type="checkbox"]')).toHaveCount(0)
  await snap(page, 'task-picked-desktop')
  await pane.locator(`[data-testid="agent-task"][data-task="${t1.id}"]`).click()
  await expect(conv(page)).toBeVisible()
  await expect(detail).toHaveCount(0)
})

test('a task title shows that task in the agent page, the Tasks pane kept and the task selected; routed, back to the stream', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t1 = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  const t2 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Update the login screen copy', session_id: a.id })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(minbox.url)
  await page.locator(`[data-testid="agents"] [data-session="${a.id}"], [data-testid="agents"] button:has-text("api")`).first().click()
  await expect(conv(page)).toBeVisible()
  const row = (id: string) => page.getByTestId('tasks-pane').locator(`[data-testid="agent-task"][data-task="${id}"]`)
  const detail = page.getByTestId('agent-task-detail')

  // A title: that task (header, messages, reply box) in the page; the pane and the agents list stay.
  await row(t1.id).click()
  await expect(page).toHaveURL(new RegExp(`v=agent.*k=${t1.id}`))
  await expect(detail.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(detail.getByTestId('v3-message').filter({ hasText: 'please fix the gauge reading' })).toBeVisible()
  await expect(detail.getByTestId('task-composer')).toBeVisible()
  await expect(conv(page)).toHaveCount(0)
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(row(t1.id)).toHaveAttribute('aria-current', 'true')
  await expect(row(t2.id)).not.toHaveAttribute('aria-current', 'true')
  await snap(page, 'detail-desktop')

  // A reply from it: to the agent, about the task.
  await detail.getByTestId('composer-text').fill('check the second gauge too')
  await detail.getByTestId('composer-send').click()
  await expect
    .poll(async () => {
      const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
      const m = s.messages.find((x: any) => x.author === 'user' && x.words === 'check the second gauge too')
      return m ? m.tasks.map((x: any) => x.task_id) : null
    })
    .toEqual([t1.id])

  // Another title replaces it; a reload keeps it; ‹ goes back to the stream.
  await row(t2.id).click()
  await expect(detail.getByTestId('task-title')).toHaveText('Update the login screen copy')
  await expect(row(t2.id)).toHaveAttribute('aria-current', 'true')
  await page.reload()
  await expect(detail.getByTestId('task-title')).toHaveText('Update the login screen copy')
  await expect(page.getByTestId('back')).toHaveAccessibleName(/Back to api/)
  await page.getByTestId('back').click()
  await expect(conv(page)).toBeVisible()
  await expect(page).not.toHaveURL(/k=/)
  // Forward: the task again.
  await page.goForward()
  await expect(detail.getByTestId('task-title')).toHaveText('Update the login screen copy')
  // No ✕ on the card: its row in the Tasks pane, clicked again, goes back to the stream.
  await expect(detail.getByTestId('task-detail-close')).toHaveCount(0)
  await row(t2.id).click()
  await expect(conv(page)).toBeVisible()

  // The Board (and Search, old #v=task deep links) open the same: the agent's page with the task.
  await page.getByTestId('nav-board').click()
  await page.goto(minbox.url + `/#v=task&k=${t1.id}`)
  await expect(detail.getByTestId('task-column')).toHaveAttribute('data-task', t1.id)
  await expect(page).toHaveURL(new RegExp(`s=${a.id}.*v=agent.*k=${t1.id}`))
  // From the task's card, an agent opens on its stream (the task's k does not carry over).
  await detail.getByTestId('task-agent').first().click()
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', a.id)
  await expect(detail).toHaveCount(0)
})


test('the Columns page is gone: no sidebar item, Board button, g c or palette entry; an old link lands on the Board', async ({ page, minbox }) => {
  await page.goto(minbox.url + '/#v=columns')
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(page).not.toHaveURL(/v=columns/)
  await expect(page.getByTestId('nav-columns')).toHaveCount(0)
  await expect(page.getByTestId('open-columns')).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('c')
  await expect(page.getByTestId('board')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('columns')
  await expect(page.getByTestId('palette')).not.toContainText('Open Columns')
})

test.describe('tablet', () => {
  test.use({ viewport: { width: 900, height: 800 } })
  test('task rows have no checkbox', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    const t1 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Fix the gauge reading', session_id: a.id })
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    const pane = page.getByTestId('tasks-pane')
    await expect(pane).toHaveAttribute('data-shown', 'true')
    await expect(pane.locator(`[data-testid="agent-task"][data-task="${t1.id}"]`)).toBeVisible()
    await expect(pane.locator('input[type="checkbox"]')).toHaveCount(0)
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test("the agent sheet's Tasks list has no checkbox; an old columns choice still shows the stream", async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await say(minbox, a, 'please fix the gauge reading')
    const t1 = await taskNamed(minbox, /Fix the gauge reading/)
    await page.goto(minbox.url)
    await page.evaluate(([s, t]) => localStorage.setItem('minbox:v3-columns:' + s, JSON.stringify({ all: false, ids: [t] })), [a.id, t1.id])
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    await page.reload()
    await expect(conv(page)).toBeVisible()
    await expect(page.getByTestId('task-column')).toHaveCount(0)
    await page.getByTestId('agent-sheet-open').tap()
    const row = page.locator(`[data-testid="agent-task"][data-task="${t1.id}"]`)
    await expect(row).toBeVisible()
    await expect(page.getByTestId('agent-side').locator('input[type="checkbox"]')).toHaveCount(0)
    await expect(page.getByTestId('agent-side').getByRole('checkbox')).toHaveCount(0)
    await snap(page, 'tasks-sheet-phone')
    // A row opens that task.
    await row.tap()
    await expect(page.getByTestId('agent-task-detail').getByTestId('task-title')).toHaveText(/Fix the gauge reading/)
  })
})

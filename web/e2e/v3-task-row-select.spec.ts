// Selecting a task row never moves its content: the selected row's background and accent edge are
// drawn without changing the row's layout, so the title (and, in All agents, the agent badge) keep
// their x and width. In an agent's Tasks pane and in All agents, at desktop and phone width (the
// phone's sheet shows the selected row when it is opened with a task picked), light and dark.
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { api, startAgent, type Agent } from './v3'

/** ROW_SELECT_SHOTS=<dir>: screenshots (for review). */
async function shot(page: Page, name: string) {
  const dir = process.env.ROW_SELECT_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await page.screenshot({ path: join(dir, `${name}-${theme}.png`) })
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme)
}

type Geo = { title: { x: number; w: number }; badge: { x: number; w: number } | null }
async function geo(row: Locator): Promise<Geo> {
  return row.evaluate((el) => {
    // The title's own text: the .v-a line's text node (an open task) or its title span.
    const a = el.querySelector('.v-a')!
    const span = a.querySelector('.v-rd-t, .v-done-t')
    let r: DOMRect
    if (span) r = span.getBoundingClientRect()
    else {
      const range = document.createRange()
      const text = [...a.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim())!
      range.selectNodeContents(text)
      r = range.getBoundingClientRect()
    }
    const b = el.querySelector('[data-testid="task-agent-badge"]')?.getBoundingClientRect()
    return { title: { x: r.x, w: r.width }, badge: b ? { x: b.x, w: b.width } : null }
  })
}

async function setup(minbox: Parameters<typeof startAgent>[0]) {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  const task = (ag: Agent, title: string) => api(minbox, 'POST', '/api/v3/tasks', { project_id: ag.project_id, title, session_id: ag.id })
  const t1 = await task(a, 'Fix the gauge reading on the dashboard header')
  const t2 = await task(a, 'Update the login screen copy')
  const t3 = await task(b, 'Restyle the login page')
  return { a, b, t1, t2, t3 }
}

// [name, hash without k, the task to select, whether rows carry a badge]
async function check(page: Page, url: string, hash: string, id: string, list: () => Locator, badge: boolean, name: string, phone: boolean) {
  const row = () => list().locator(`[data-testid="agent-task"][data-task="${id}"]`)
  await page.goto(url + '/#' + hash + (phone ? '&tab=tasks' : ''))
  await expect(row()).toBeVisible()
  await expect(row()).not.toHaveAttribute('aria-current', 'true')
  const before = await geo(row())
  await shot(page, name + '-unselected')
  if (phone) {
    // A tap opens the task (the sheet closes); with the task picked, the sheet shows its row selected.
    await page.goto(url + '/#' + hash + `&k=${id}&tab=tasks`)
  } else {
    await row().click()
  }
  await expect(row()).toHaveAttribute('aria-current', 'true')
  const after = await geo(row())
  await shot(page, name + '-selected')
  expect(before.title.w).toBeGreaterThan(20)
  expect(after.title.x).toBeCloseTo(before.title.x, 1)
  expect(after.title.w).toBeCloseTo(before.title.w, 1)
  if (badge) {
    expect(before.badge).not.toBeNull()
    expect(after.badge!.x).toBeCloseTo(before.badge!.x, 1)
    expect(after.badge!.w).toBeCloseTo(before.badge!.w, 1)
  }
  // The selected row stays inside the list (no horizontal scroll from its highlight).
  expect(await list().evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0)
}

test('desktop: selecting a row in the Tasks pane and in All agents keeps its title and badge in place', async ({ page, minbox }) => {
  const { a, t1, t3 } = await setup(minbox)
  await page.setViewportSize({ width: 1500, height: 900 })
  const pane = () => page.getByTestId('tasks-pane').locator('.v-tasks-body')
  await check(page, minbox.url, `v=agent&s=${a.id}`, t1.id, pane, false, 'agent-desktop', false)
  await check(page, minbox.url, 'v=alltasks', t3.id, pane, true, 'all-desktop', false)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test("selecting a row in the agent sheet's Tasks and in All agents keeps its title and badge in place", async ({ page, minbox }) => {
    const { a, t1, t3 } = await setup(minbox)
    const sheet = () => page.getByTestId('agent-side').locator('> div').last()
    await check(page, minbox.url, `v=agent&s=${a.id}`, t1.id, sheet, false, 'agent-phone', true)
    await check(page, minbox.url, 'v=alltasks', t3.id, sheet, true, 'all-phone', true)
  })
})

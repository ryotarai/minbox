// Task columns on an agent's page (the standalone Columns page is gone): each task in the agent's Tasks
// pane has a checkbox, with a tri-state "All" (every open task of the agent, new ones too) on top. Checked
// tasks show side by side in place of the stream, each with its messages and a reply box to its agent;
// no bar over them: the Tasks pane's "N checked · Clear" unchecks them all (the stream again). Kept per
// agent across a reload. While columns hide the stream, the Tasks pane has a message box to the agent
// itself (one task picked: only the task's box, see v3-one-composer). A tablet shows one column at a time with tabs; a phone keeps the stream.
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
const check = (page: Page, id: string) => page.locator(`[data-testid="agent-task-check"][data-task="${id}"]`)
const conv = (page: Page) => page.getByTestId('stream-view').getByTestId('conv-bar')

test('tasks pane checkboxes: All tri-state, columns in place of the stream, a reply from a column, kept per agent, back to the stream', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  await say(minbox, a, 'please fix the gauge reading')
  const t1 = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  const t2 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Update the login screen copy', session_id: a.id })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)

  // Nothing checked: the stream (its own box; none in the Tasks pane).
  await expect(conv(page)).toBeVisible()
  await expect(page.getByTestId('tasks-composer')).toHaveCount(0)
  await expect(page.getByTestId('agent-tasks-all')).toHaveAttribute('data-state', 'off')

  // One: All turns partial, the stream gives way to its column.
  await check(page, t1.id).check()
  await expect(page.getByTestId('agent-tasks-all')).toHaveAttribute('data-state', 'some')
  await expect(page.getByTestId('task-column')).toHaveCount(1)
  await expect(conv(page)).toHaveCount(0)
  await expect(col(page, t1.id).getByTestId('column-title')).toHaveText('Fix the gauge reading')
  await expect(col(page, t1.id).getByTestId('v3-message').filter({ hasText: 'please fix the gauge reading' })).toBeVisible()
  // No bar over the columns: the Tasks pane counts them, with Clear; its message box shows.
  await expect(page.getByTestId('columns-bar')).toHaveCount(0)
  await expect(page.getByTestId('tasks-clear')).toHaveText('1 checked · Clear')
  await expect(page.getByTestId('tasks-composer')).toBeVisible()

  // All: both, side by side, equal widths.
  await page.getByTestId('agent-tasks-all').check()
  await expect(page.getByTestId('agent-tasks-all')).toHaveAttribute('data-state', 'on')
  await expect(page.getByTestId('task-column')).toHaveCount(2)
  const [w1, w2] = await Promise.all([col(page, t1.id).boundingBox(), col(page, t2.id).boundingBox()])
  expect(Math.abs(w1!.width - w2!.width)).toBeLessThan(2)
  expect(w2!.x).toBeGreaterThan(w1!.x + w1!.width - 2)
  expect(w1!.width).toBeGreaterThanOrEqual(318)
  await expect(col(page, t2.id).getByTestId('composer-to')).toHaveValue(a.id)
  await snap(page, 'columns-desktop')

  // The folded strip counts the checked ones.
  await page.getByTestId('tasks-pane-toggle').first().click()
  await expect(page.getByTestId('tasks-strip-checked')).toHaveText('2')
  await snap(page, 'columns-strip')
  await page.getByTestId('tasks-pane-toggle').click()

  // A reply from a column: to the task's agent, about that task.
  await col(page, t1.id).getByTestId('composer-text').fill('use the shorter wording')
  await col(page, t1.id).getByTestId('composer-send').click()
  await expect(col(page, t1.id).getByTestId('v3-message').filter({ hasText: 'use the shorter wording' })).toBeVisible()
  await expect
    .poll(async () => {
      const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
      const m = s.messages.find((x: any) => x.author === 'user' && x.words === 'use the shorter wording')
      return m ? m.tasks.map((x: any) => x.task_id) : null
    })
    .toEqual([t1.id])

  // Unchecking one of All: partial; kept across a reload.
  await check(page, t2.id).uncheck()
  await expect(page.getByTestId('agent-tasks-all')).toHaveAttribute('data-state', 'some')
  await expect(page.getByTestId('task-column')).toHaveCount(1)
  await page.reload()
  await expect(page.getByTestId('task-column')).toHaveCount(1)
  await expect(col(page, t1.id)).toBeVisible()
  await expect(check(page, t2.id)).not.toBeChecked()

  // Another agent has its own choice (none).
  await page.goto(minbox.url + `/#v=agent&s=${b.id}`)
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', b.id)
  await expect(page.getByTestId('task-column')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByTestId('task-column')).toHaveCount(1)

  // ✕ on a column unchecks it; the last one gone, the stream (and the pane's box goes).
  await col(page, t1.id).getByTestId('column-remove').click()
  await expect(conv(page)).toBeVisible()
  await expect(page.getByTestId('tasks-composer')).toHaveCount(0)

  // Clear (in the Tasks pane) unchecks them all.
  await page.getByTestId('agent-tasks-all').check()
  await expect(page.getByTestId('task-column')).toHaveCount(2)
  await page.getByTestId('tasks-clear').click()
  await expect(page.getByTestId('task-column')).toHaveCount(0)
  await expect(page.getByTestId('agent-tasks-all')).toHaveAttribute('data-state', 'off')
  await expect(conv(page)).toBeVisible()

  // A column's title shows that task in the agent's page (no Open link any more).
  await check(page, t2.id).check()
  await expect(col(page, t2.id).getByTestId('column-open')).toHaveCount(0)
  await col(page, t2.id).getByTestId('column-title').click()
  await expect(page.getByTestId('agent-task-detail').getByTestId('task-column')).toHaveAttribute('data-task', t2.id)
  await expect(page).toHaveURL(new RegExp(`s=${a.id}.*v=agent.*k=${t2.id}`))
})

test('a task title shows that task in the agent page, the Tasks pane kept and the task selected; routed, back to the stream; checkboxes switch to columns', async ({ page, minbox }) => {
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

  // A checkbox: the columns, leaving the one task; a title from there shows that one, again back to the columns.
  await row(t1.id).click()
  await expect(detail).toBeVisible()
  await check(page, t2.id).check()
  await expect(detail).toHaveCount(0)
  await expect(page).not.toHaveURL(/k=/)
  await expect(page.getByTestId('task-column')).toHaveCount(1)
  await expect(col(page, t2.id)).toBeVisible()
  await row(t1.id).click()
  await expect(detail.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(page.getByTestId('columns-bar')).toHaveCount(0)
  await row(t1.id).click()
  await expect(col(page, t2.id)).toBeVisible()

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

test('the Tasks pane message box: to the agent itself while columns fill the page (not with one task), the stream draft shared, shown in the stream', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const t1 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Fix the gauge reading', session_id: a.id })
  const t2 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Update the login screen copy', session_id: a.id })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(conv(page)).toBeVisible()
  const box = page.getByTestId('tasks-composer')
  await expect(box).toHaveCount(0)
  const inStream = async (words: string) => {
    const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
    return s.messages.some((x: any) => x.author === 'user' && x.words === words)
  }

  // Columns: the box sits at the pane's bottom; a message goes to the agent (no task picked), ✓ briefly.
  await page.getByTestId('agent-tasks-all').check()
  await expect(page.getByTestId('task-column')).toHaveCount(2)
  await expect(box).toBeVisible()
  await expect(box.getByTestId('composer-to')).toHaveCount(0)
  await expect(box).toContainText('api')
  const pane = (await page.locator('.v-tasks').boundingBox())!
  const bb = (await box.boundingBox())!
  expect(bb.y + bb.height).toBeGreaterThan(pane.y + pane.height - 20)
  expect(bb.height).toBeLessThan(140)
  await box.getByTestId('composer-text').fill('what is left on the deploy?')
  await snap(page, 'tasks-composer-columns')
  await box.getByTestId('composer-text').press('ControlOrMeta+Enter')
  await expect(page.getByTestId('tasks-composer-sent')).toHaveText('Sent to api')
  await snap(page, 'tasks-composer-sent')
  await expect.poll(() => inStream('what is left on the deploy?')).toBe(true)
  await expect(box.getByTestId('composer-text')).toHaveValue('')
  await expect(page.getByTestId('tasks-composer-sent')).toHaveCount(0, { timeout: 6000 })

  // One task (its title): only the task's own box (the pane's goes); its "Send without task" reaches the stream.
  await page.getByTestId('tasks-pane').locator(`[data-testid="agent-task"][data-task="${t1.id}"]`).click()
  await expect(page.getByTestId('agent-task-detail')).toBeVisible()
  await expect(box).toHaveCount(0)
  await expect(page.getByTestId('composer-text')).toHaveCount(1)
  const one = page.getByTestId('task-composer')
  await one.getByTestId('composer-text').fill('and the release notes')
  await one.getByTestId('composer-send-untagged').click()
  await expect.poll(() => inStream('and the release notes')).toBe(true)

  // The draft is the stream's: words left in the pane's box are in the stream's box once it shows.
  await page.getByTestId('tasks-pane').locator(`[data-testid="agent-task"][data-task="${t1.id}"]`).click()
  await expect(page.getByTestId('task-column')).toHaveCount(2)
  await box.getByTestId('composer-text').fill('half a thought')
  await page.getByTestId('tasks-clear').click()
  await expect(conv(page)).toBeVisible()
  await expect(box).toHaveCount(0)
  await expect(page.getByTestId('stream-view').getByTestId('composer-text')).toHaveValue('half a thought')
  // Both messages are in the stream.
  await expect(page.getByTestId('stream-view').locator('[data-testid="v3-message"][data-author="user"]').filter({ hasText: 'what is left on the deploy?' })).toBeVisible()
  await expect(page.getByTestId('stream-view').locator('[data-testid="v3-message"][data-author="user"]').filter({ hasText: 'and the release notes' })).toBeVisible()
  void t2

  // Folded, the strip has no box.
  await page.getByTestId('agent-tasks-all').check()
  await page.getByTestId('tasks-pane-toggle').first().click()
  await expect(page.getByTestId('tasks-strip-checked')).toBeVisible()
  await expect(box).toHaveCount(0)
})

test('many checked tasks scroll sideways at a minimum width; a new open task joins All', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  for (const t of ['alpha', 'bravo', 'charlie', 'delta', 'echo']) await api(minbox, 'POST', '/api/v3/tasks', { title: 'Task ' + t, session_id: a.id })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await page.getByTestId('agent-tasks-all').check()
  await expect(page.getByTestId('task-column')).toHaveCount(5)
  const strip = page.getByTestId('columns')
  expect(await strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  expect((await page.getByTestId('task-column').first().boundingBox())!.width).toBeGreaterThanOrEqual(318)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await snap(page, 'columns-many')
  const t6 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Task foxtrot', session_id: a.id })
  await expect(col(page, t6.id)).toBeVisible()
  await expect(page.getByTestId('task-column')).toHaveCount(6)
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
  test('one column at a time, a tab per checked task', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    const t1 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Fix the gauge reading', session_id: a.id })
    const t2 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Update the login screen copy', session_id: a.id })
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    // The Tasks pane beside the stream on a tablet with room for it.
    await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
    await page.getByTestId('agent-tasks-all').check()
    await expect(page.getByTestId('columns-tabs')).toBeVisible()
    await expect(page.getByTestId('task-column')).toHaveCount(1)
    await expect(col(page, t1.id)).toBeVisible()
    await page.locator(`[data-testid="columns-tab"][data-task="${t2.id}"]`).click()
    await expect(col(page, t2.id)).toBeVisible()
    await expect(page.getByTestId('task-column')).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await snap(page, 'columns-tablet')
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('a phone keeps the stream and a plain Tasks list', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await say(minbox, a, 'please fix the gauge reading')
    const t1 = await taskNamed(minbox, /Fix the gauge reading/)
    // Checked on a wider screen earlier: the phone still shows the stream.
    await page.goto(minbox.url)
    await page.evaluate(([s, t]) => localStorage.setItem('minbox:v3-columns:' + s, JSON.stringify({ all: false, ids: [t], stream: false })), [a.id, t1.id])
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    await expect(conv(page)).toBeVisible()
    await expect(page.getByTestId('task-column')).toHaveCount(0)
    await page.getByTestId('agent-sheet-open').tap()
    await expect(page.locator(`[data-testid="agent-task"][data-task="${t1.id}"]`)).toBeVisible()
    await expect(page.getByTestId('agent-task-check')).toHaveCount(0)
  })
})

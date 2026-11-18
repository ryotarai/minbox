// The ‹ back control in every view's header (phone, tablet with the sidebar folded, desktop): it goes
// to where the person came from in the app — the browser's own back, so button, Esc, browser back
// and swipe-back walk the same entries — and on a view opened directly (a link, a reload) it replaces
// that entry with the Board, so a browser back from there leaves the app instead of bouncing.
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures'
import { api, say, startAgent, taskNamed, type Agent } from './v3'

const SHOTS = process.env.BACK_SHOTS // a folder: screenshots of the headers (light and dark)
async function snap(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` })
  }
}

const back = (page: Page) => page.getByTestId('v3-app').getByTestId('back')
const view = (page: Page) => page.getByTestId('v3-app')
const historyLength = (page: Page) => page.evaluate(() => history.length)

async function setup(minbox: Parameters<typeof startAgent>[0]) {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  return { a, t }
}

async function openTask(page: Page, t: { id: string }, tap = false) {
  const row = page.locator(`[data-testid="task-row"][data-task="${t.id}"] .v-line`)
  await expect(row).toBeVisible()
  // A click (a tap) on the row opens the task.
  await (tap ? row.tap() : row.click())
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
}

/** Board → the task (its row) → the agent (the task's agent chip). */
async function boardTaskAgent(page: Page, url: string, a: Agent, t: { id: string }, prefix: string, tap = false) {
  await page.goto(url)
  await expect(view(page)).toHaveAttribute('data-view', 'board')
  await expect(back(page)).toHaveCount(0) // home: no back
  await openTask(page, t, tap)
  await expect(back(page)).toHaveAccessibleName('Back to Board')
  await snap(page, prefix + '-task')
  const chip = page.getByTestId('task-agent').filter({ hasText: a.name })
  await (tap ? chip.tap() : chip.click())
  await expect(page.getByTestId('agent-name')).toContainText('api')
  await expect(back(page)).toHaveAccessibleName('Back to Fix the gauge reading')
  await snap(page, prefix + '-agent')
}

async function backTwiceThenBrowser(page: Page, press: () => Promise<void>) {
  const len = await historyLength(page)
  await press()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(back(page)).toHaveAccessibleName('Back to Board')
  await press()
  await expect(view(page)).toHaveAttribute('data-view', 'board')
  // The browser's own history went back too (no new entries): forward is the task, then the agent.
  expect(await historyLength(page)).toBe(len)
  await page.goForward()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await page.goForward()
  await expect(page.getByTestId('agent-name')).toContainText('api')
  // And the browser's back matches the button.
  await page.goBack()
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(back(page)).toHaveAccessibleName('Back to Board')
}

/** A link straight to the task: ‹ replaces it with the Board; the browser's back then leaves the app (no loop). */
async function deepLink(page: Page, url: string, t: { id: string }, tap = false) {
  await page.goto('about:blank')
  await page.goto(url + `/#v=task&k=${t.id}`)
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  await expect(back(page)).toHaveAccessibleName('Back to Board')
  await expect(back(page)).toHaveAttribute('data-to', 'board')
  const len = await historyLength(page)
  await (tap ? back(page).tap() : back(page).click())
  await expect(view(page)).toHaveAttribute('data-view', 'board')
  expect(new URL(page.url()).hash).toBe('')
  expect(await historyLength(page)).toBe(len)
  await page.goBack()
  await expect.poll(() => page.url()).toBe('about:blank')
  await page.goForward()
  await expect(view(page)).toHaveAttribute('data-view', 'board')
  await expect(back(page)).toHaveCount(0)
}

test.describe('desktop', () => {
  test('Board → task → agent: ‹ and Esc go back the same way as the browser', async ({ page, minbox }) => {
    const { a, t } = await setup(minbox)
    await boardTaskAgent(page, minbox.url, a, t, 'desktop')
    await expect(page.getByText('Esc · Board')).toHaveCount(0)
    await backTwiceThenBrowser(page, () => back(page).click())
    // Esc does what ‹ does.
    await page.goBack()
    await expect(view(page)).toHaveAttribute('data-view', 'board')
    await openTask(page, t)
    await page.getByTestId('task-agent').filter({ hasText: a.name }).click()
    await expect(page.getByTestId('agent-name')).toContainText('api')
    await page.getByTestId('stream-view').locator('.v-scroll').click()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
    await page.getByTestId('task-title').click()
    await page.keyboard.press('Escape')
    await expect(view(page)).toHaveAttribute('data-view', 'board')
  })

  test('a deep link: ‹ replaces it with the Board; Esc too', async ({ page, minbox }) => {
    const { t } = await setup(minbox)
    await deepLink(page, minbox.url, t)
    await page.goto(minbox.url + `/#v=task&k=${t.id}`)
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
    await page.getByTestId('task-title').click()
    await page.keyboard.press('Escape')
    await expect(view(page)).toHaveAttribute('data-view', 'board')
  })

  test('Search and Settings: back to where they were opened from', async ({ page, minbox }) => {
    const { t } = await setup(minbox)
    await page.goto(minbox.url + `/#v=task&k=${t.id}`)
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
    await page.getByTestId('nav-search').click()
    await expect(page.getByTestId('search-view')).toBeVisible()
    await expect(back(page)).toHaveAccessibleName('Back to Fix the gauge reading')
    await snap(page, 'desktop-search')
    await back(page).click()
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
    // Esc in the search box: back as well.
    await page.getByTestId('nav-search').click()
    await page.getByTestId('search-input').press('Escape')
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')

    // Settings from the rail; a section or two; ‹ leaves Settings (all its sections) in one step.
    await page.getByTestId('open-settings').click()
    await expect(page.getByTestId('settings')).toBeVisible()
    await expect(page.getByTestId('settings-back')).toHaveAccessibleName(/^Back to /)
    await page.getByTestId('settings-nav-hosts').click()
    await page.getByTestId('settings-nav-about').click()
    await snap(page, 'desktop-settings')
    await page.getByTestId('settings-back').click()
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
    // A link straight to Settings: Esc → the Board.
    await page.goto(minbox.url + '/#v=settings&ss=hosts')
    await expect(page.getByTestId('settings')).toBeVisible()
    await expect(page.getByTestId('settings-back')).toHaveAccessibleName('Back to Board')
    await page.keyboard.press('Escape')
    await expect(view(page)).toHaveAttribute('data-view', 'board')
  })
})

test.describe('tablet', () => {
  test.use({ viewport: { width: 900, height: 1200 }, hasTouch: true })

  test('sidebar folded: ‹ in the header goes task ← agent ← Board; deep link → Board', async ({ page, minbox }) => {
    const { a, t } = await setup(minbox)
    await page.goto(minbox.url)
    await expect(view(page)).toHaveAttribute('data-layout', 'tablet')
    await openTask(page, t, true)
    // The sidebar folded away; ☰ on the rail; ‹ Board at the start of the header, with its name.
    await expect(page.getByTestId('sidebar')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-toggle')).toBeVisible()
    await expect(back(page)).toBeVisible()
    await expect(back(page)).toHaveText('Board')
    const b = (await back(page).boundingBox())!
    const title = (await page.getByTestId('task-title').boundingBox())!
    expect(b.x + b.width).toBeLessThanOrEqual(title.x + 1)
    expect(b.height).toBeGreaterThanOrEqual(38) // a touch target
    await snap(page, 'tablet-task')
    await page.getByTestId('task-agent').filter({ hasText: a.name }).tap()
    await expect(page.getByTestId('agent-name')).toContainText('api')
    await expect(back(page)).toHaveText('Fix the gauge reading')
    await snap(page, 'tablet-agent')
    await back(page).tap()
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
    await back(page).tap()
    await expect(view(page)).toHaveAttribute('data-view', 'board')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await deepLink(page, minbox.url, t, true)
  })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('‹ on a task, an agent, Search, Agents and Settings; deep link → Board', async ({ page, minbox }) => {
    const { a, t } = await setup(minbox)
    await boardTaskAgent(page, minbox.url, a, t, 'phone', true)
    const b = (await back(page).boundingBox())!
    expect(b.width).toBeGreaterThanOrEqual(43)
    expect(b.x).toBeGreaterThanOrEqual(0)
    await backTwiceThenBrowser(page, () => back(page).tap())
    await page.goBack()
    await expect(view(page)).toHaveAttribute('data-view', 'board')

    // Search tab → ‹ → the Board.
    await page.getByTestId('tab-search').tap()
    await expect(page.getByTestId('search-view')).toBeVisible()
    await back(page).tap()
    await expect(view(page)).toHaveAttribute('data-view', 'board')
    // Agents tab → Settings → a section → ‹ (leaves Settings) → Agents → ‹ → Board.
    await page.getByTestId('tab-agents').tap()
    await expect(page.getByTestId('agents-view')).toBeVisible()
    await expect(back(page)).toHaveAccessibleName('Back to Board')
    await page.getByTestId('open-settings-phone').tap()
    await expect(page.getByTestId('settings')).toBeVisible()
    await page.getByTestId('settings-nav-about').tap()
    await expect(page.getByTestId('settings-back')).toHaveAccessibleName('Back to Agents')
    await snap(page, 'phone-settings')
    await page.getByTestId('settings-back').tap()
    await expect(page.getByTestId('agents-view')).toBeVisible()
    await back(page).tap()
    await expect(view(page)).toHaveAttribute('data-view', 'board')

    await deepLink(page, minbox.url, t, true)
  })

  test("an agent's sheet: its tasks (just-done ones muted), a task and back, the terminal and files; the task's details", async ({ page, minbox }) => {
    const { a, t } = await setup(minbox)
    await say(minbox, a, 'please add the dark mode toggle')
    const done = await taskNamed(minbox, /dark mode/i)
    await api(minbox, 'PATCH', `/api/v3/tasks/${done.id}`, { status: 'done' })
    await page.goto(minbox.url)
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    await expect(page.getByTestId('composer-text')).toBeVisible()
    await expect(page.getByTestId('agent-side')).toHaveCount(0)
    const open = page.getByTestId('agent-sheet-open')
    await expect(open).toContainText('Tasks 1')
    await open.tap()
    // The sheet takes the screen: Tasks first, the stream and its reply box hidden.
    await expect(page.getByTestId('agent-side')).toHaveAttribute('data-sheet', 'true')
    await expect(page.getByTestId('composer-text')).toBeHidden()
    await expect(page.getByTestId('pane-tasks')).toHaveClass(/on/)
    const tasksList = page.getByTestId('agent-tasks')
    await expect(tasksList.locator(`[data-testid="agent-task"][data-task="${t.id}"]`)).toBeVisible()
    // Just done: listed (muted) under RECENTLY DONE, not folded (see v3-recent-done).
    await expect(tasksList.getByTestId('agent-tasks-recent').locator(`[data-testid="agent-task"][data-task="${done.id}"]`)).toBeVisible()
    await expect(tasksList.getByText('DONE THIS WEEK')).toHaveCount(0)
    // Only tasks: the agent's kind / folder / start live in its ⋯ menu.
    await expect(tasksList).not.toContainText('Folder')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await snap(page, 'phone-agent-sheet')

    // A task from the sheet; ‹ comes back to the agent with its sheet.
    await tasksList.locator(`[data-testid="agent-task"][data-task="${t.id}"]`).tap()
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
    await expect(back(page)).toHaveAccessibleName('Back to api')
    // The task's details (checklist, latest from the agent, facts) behind Details.
    await expect(page.getByTestId('task-side')).toHaveCount(0)
    await page.getByRole('button', { name: 'Details' }).tap()
    await expect(page.getByTestId('task-side')).toBeVisible()
    await expect(page.getByTestId('task-side').getByTestId('step')).toHaveCount(4)
    await expect(page.getByTestId('task-side')).toContainText('LATEST FROM THE AGENT')
    await expect(page.getByTestId('task-side')).toContainText('FACTS')
    await back(page).tap()
    await expect(page.getByTestId('agent-side')).toHaveAttribute('data-sheet', 'true')
    await expect(page.getByTestId('agent-tasks')).toBeVisible()

    // Terminal and Files as tabs of the sheet.
    await page.getByTestId('pane-terminal').tap()
    await expect(page.getByTestId('terminal')).toBeVisible()
    await page.getByTestId('pane-files').tap()
    await expect(page.getByTestId('files-pane')).toBeVisible()
    await page.getByTestId('pane-tasks').tap()
    await expect(page.getByTestId('agent-tasks')).toBeVisible()
    // ‹ (or the browser's back) closes the sheet: the stream again.
    await page.getByTestId('agent-sheet-close').tap()
    await expect(page.getByTestId('agent-side')).toHaveCount(0)
    await expect(page.getByTestId('composer-text')).toBeVisible()
    await open.tap()
    await expect(page.getByTestId('agent-tasks')).toBeVisible()
    await page.goBack()
    await expect(page.getByTestId('agent-side')).toHaveCount(0)
    await expect(page.getByTestId('composer-text')).toBeVisible()

    // A link straight to the sheet: closing it replaces the entry with the stream.
    await page.goto(minbox.url + `/#v=agent&s=${a.id}&tab=tasks`)
    await expect(page.getByTestId('agent-tasks')).toBeVisible()
    await page.getByTestId('agent-sheet-close').tap()
    await expect(page.getByTestId('composer-text')).toBeVisible()
    expect(new URL(page.url()).hash).not.toContain('tab=tasks')
  })
})

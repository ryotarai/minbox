// The v3 shell's layout, as main had it (narrow.spec, terminal-toggle.spec, files-pane.spec's ⇧F,
// v2.spec's resizable edges and swapped panes, projects.spec's phone sheet, the notification ask):
// the side panes (terminal | shell | files, each shown or hidden on its own, side by side) are kept across
// agents and reloads, edges drag and keep their widths, Settings › swap panes, the tablet's two panes
// (one side pane at a time), the phone's full-screen terminal and project sheet.
import type { Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures'
import { api, startAgent } from './v3'

const box = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
// SIDE_PANES_SHOTS: a folder for screenshots of the side panes (light and dark).
const SHOTS = process.env.SIDE_PANES_SHOTS
async function shot(page: Page, name: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
    await page.waitForTimeout(150)
    await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` })
  }
}

test('the terminal pane stays open across agents and a reload; ⇧F shows the files beside it and hides them', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  const b = await startAgent(minbox, 'beta')
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await page.getByTestId('agent-row').filter({ hasText: 'beta' }).click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  await page.reload()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'true')

  // No tab strip: ⇧F shows the files beside the terminal, and hides them again.
  await page.getByTestId('stream-view').locator('.v-scroll').click()
  await page.keyboard.press('Shift+F')
  await expect(page.getByTestId('files-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal files')
  await expect(page.getByTestId('pane-files')).toHaveCount(0)
  await page.keyboard.press('Shift+F')
  await expect(page.getByTestId('side-files')).toHaveCount(0)
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal')
  await page.getByTestId('terminal-close').click()
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', '')
  await page.reload()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
  void b
})

test('terminal, shell and files open together side by side, each with its own width and ×; kept across a reload', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  await page.setViewportSize({ width: 2400, height: 900 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
  // Opened in another order than they stand: terminal | shell | files after the stream.
  await page.getByTestId('files-toggle').click()
  await page.getByTestId('shell-toggle').click()
  await page.getByTestId('terminal-toggle').click()
  for (const t of ['terminal-toggle', 'shell-toggle', 'files-toggle']) await expect(page.getByTestId(t)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal shell files')
  await expect(page.getByTestId('terminal')).toHaveCount(2) // the agent's and the shell's
  const sv = await box(page, 'stream-view')
  const st = await box(page, 'side-terminal')
  const ss = await box(page, 'side-shell')
  const sf = await box(page, 'side-files')
  expect(sv.width).toBeGreaterThanOrEqual(378)
  expect(sv.x + sv.width).toBeLessThanOrEqual(st.x + 1)
  expect(st.x + st.width).toBeLessThanOrEqual(ss.x + 1)
  expect(ss.x + ss.width).toBeLessThanOrEqual(sf.x + 1)
  await noOverflow(page)
  await shot(page, 'three-panes')

  // The shell's edge drags the shell alone (narrower: the stream has no room to give).
  const rz = await box(page, 'side-resizer-shell')
  await page.mouse.move(rz.x + rz.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(rz.x + rz.width / 2 + 40, 400, { steps: 4 })
  await page.mouse.move(rz.x + rz.width / 2 + 80, 400, { steps: 4 })
  await page.mouse.up()
  const ss1 = await box(page, 'side-shell')
  expect(Math.abs(ss1.width - (ss.width - 80))).toBeLessThan(4)
  expect(Math.abs((await box(page, 'side-files')).width - sf.width)).toBeLessThan(2)
  expect(Math.abs((await box(page, 'side-terminal')).width - st.width)).toBeLessThan(2)

  // Kept across a reload: which are open, and their widths.
  await page.reload()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal shell files')
  expect(Math.abs((await box(page, 'side-shell')).width - ss1.width)).toBeLessThan(2)
  expect(Math.abs((await box(page, 'side-files')).width - sf.width)).toBeLessThan(2)

  // Each closes on its own (its ×, or its button); the others stay.
  await page.getByTestId('shell-close').click()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal files')
  await expect(page.getByTestId('shell-toggle')).toHaveAttribute('aria-pressed', 'false')
  await page.getByTestId('files-close').click()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal')
  await page.getByTestId('terminal-toggle').click()
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
  await page.getByTestId('shell-toggle').click()
  await page.reload()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'shell')
})

test('a narrower window: the Tasks pane folds first, the panes squeeze, then only the last opened shows; wider again, all come back', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  await page.setViewportSize({ width: 2400, height: 900 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
  await page.getByTestId('terminal-toggle').click()
  await page.getByTestId('files-toggle').click()
  await page.getByTestId('shell-toggle').click()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal shell files')

  // 1500: no room for the Tasks pane beside all three: its strip; the panes squeeze, the stream keeps 380.
  await page.setViewportSize({ width: 1500, height: 900 })
  await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-overlay', 'true')
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal shell files')
  await expect.poll(async () => (await box(page, 'stream-view')).width).toBeGreaterThanOrEqual(378)
  for (const p of ['terminal', 'shell', 'files']) expect((await box(page, 'side-' + p)).width).toBeGreaterThanOrEqual(239)
  await noOverflow(page)
  await shot(page, 'three-panes-1500')

  // 1150: room for one beside the stream: the one opened last (the shell); the others' buttons unpressed.
  await page.setViewportSize({ width: 1150, height: 900 })
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'shell')
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(async () => (await box(page, 'stream-view')).width).toBeGreaterThanOrEqual(378)
  await noOverflow(page)
  // A button brings its pane back in place of the others.
  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal')

  // Wide again: every one still open shows.
  await page.setViewportSize({ width: 2400, height: 900 })
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal shell files')
})

test('the side pane and sidebar edges drag; the widths are kept; swapped panes put the side panes on the left', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  // A side pane (terminal, shell, files) shows when it is open.
  await expect(page.locator('[data-side-pane]')).toHaveCount(0)
  await page.keyboard.press('Shift+F')
  const side0 = await box(page, 'side-files')
  const rz = await box(page, 'side-resizer-files')
  await page.mouse.move(rz.x + rz.width / 2, rz.y + 200)
  await page.mouse.down()
  await page.mouse.move(rz.x + rz.width / 2 - 60, rz.y + 200, { steps: 4 })
  await page.mouse.move(rz.x + rz.width / 2 - 120, rz.y + 200, { steps: 4 })
  await page.mouse.up()
  const side1 = await box(page, 'side-files')
  expect(Math.abs(side1.width - (side0.width + 120))).toBeLessThan(4)

  const sb0 = await box(page, 'sidebar')
  const srz = await box(page, 'sidebar-resizer')
  await page.mouse.move(srz.x + srz.width / 2, 300)
  await page.mouse.down()
  await page.mouse.move(srz.x + srz.width / 2 + 50, 300, { steps: 5 })
  await page.mouse.up()
  const sb1 = await box(page, 'sidebar')
  expect(Math.abs(sb1.width - (sb0.width + 50))).toBeLessThan(4)
  // (A wider sidebar can leave the side pane less room: what is kept is what shows now.)
  const side2 = await box(page, 'side-files')

  await page.reload()
  expect(Math.abs((await box(page, 'side-files')).width - side2.width)).toBeLessThan(2)
  expect(Math.abs((await box(page, 'sidebar')).width - sb1.width)).toBeLessThan(2)

  // The terminal shows beside the files (not in their place); closed again, the files are as wide as before.
  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'terminal files')
  await page.getByTestId('terminal-close').click()
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'files')
  expect(Math.abs((await box(page, 'side-files')).width - side2.width)).toBeLessThan(2)

  // Settings › swap panes: the side panes on the left of the stream; an edge drags the other way.
  await api(minbox, 'PUT', '/api/settings', { swap_panes: false })
  await page.reload()
  const s2 = await box(page, 'side-files')
  const v2 = await box(page, 'stream-view')
  expect(s2.x + s2.width).toBeLessThanOrEqual(v2.x + 1)
  const rz2 = await box(page, 'side-resizer-files')
  await page.mouse.move(rz2.x + rz2.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(rz2.x + rz2.width / 2 - 40, 400, { steps: 4 })
  await page.mouse.up()
  // (On the left, dragging its edge left narrows it.)
  expect(Math.abs((await box(page, 'side-files')).width - (s2.width - 40))).toBeLessThan(4)
})

for (const width of [700, 768, 820, 900, 1024, 1099]) {
  test(`tablet ${width}px: two panes; the sidebar folds away on an agent; the terminal beside the stream`, async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'alpha')
    await page.setViewportSize({ width, height: 800 })
    await page.goto(minbox.url)
    await expect(page.getByTestId('v3-app')).toHaveAttribute('data-layout', 'tablet')
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('phone-tabs')).toHaveCount(0)
    expect((await box(page, 'project-rail')).width).toBeLessThanOrEqual(60)
    await noOverflow(page)

    await page.getByTestId('agent-row').click()
    await expect(page.getByTestId('stream-view')).toBeVisible()
    await expect(page.getByTestId('sidebar')).toHaveCount(0)
    // The Tasks pane beside the stream (the stream keeps MIN_STREAM)...
    await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
    await expect(page.getByTestId('tasks-pane')).not.toHaveAttribute('data-overlay', 'true')
    expect((await box(page, 'stream-view')).width).toBeGreaterThanOrEqual(380)
    await noOverflow(page)
    await page.getByTestId('terminal-toggle').click()
    await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
    // ...folded to its strip while a side pane takes the room.
    await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-overlay', 'true')
    await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'false')
    const s = await box(page, 'stream-view')
    const t = await box(page, 'side-terminal')
    expect(s.width).toBeGreaterThanOrEqual(300)
    expect(t.width).toBeGreaterThanOrEqual(240)
    expect(t.x).toBeGreaterThanOrEqual(s.x + s.width - 1)
    await noOverflow(page)
    // One side pane at a time on a tablet: the files take the terminal's place; × closes them.
    await page.getByTestId('files-toggle').click()
    await expect(page.getByTestId('v3-app')).toHaveAttribute('data-panes', 'files')
    await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'false')
    await noOverflow(page)
    await page.getByTestId('files-close').click()
    await expect(page.locator('[data-side-pane]')).toHaveCount(0)
    await expect(page.getByTestId('tasks-pane')).toHaveAttribute('data-shown', 'true')
    await expect(page.getByTestId('tasks-pane')).not.toHaveAttribute('data-overlay', 'true')

    // The rail's ☰ brings the sidebar back; picking a row folds it again.
    await page.getByTestId('sidebar-toggle').click()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await page.getByTestId('nav-board').click()
    await expect(page.getByTestId('board')).toBeVisible()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    void a
  })
}

test('from 1100px three columns: the sidebar stays beside an agent; resizing across the bands keeps the agent and the draft', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-layout', 'desktop')
  await expect(page.getByTestId('sidebar')).toBeVisible()
  // A resize across the bands keeps the agent and the draft in its box.
  await page.getByTestId('composer-text').fill('half-written reply')
  await page.setViewportSize({ width: 800, height: 800 })
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', a.id)
  await expect(page.getByTestId('composer-text')).toHaveValue('half-written reply')
  await page.setViewportSize({ width: 390, height: 800 })
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', a.id)
  await expect(page.getByTestId('composer-text')).toHaveValue('half-written reply')
  await page.setViewportSize({ width: 1400, height: 800 })
  await expect(page.getByTestId('composer-text')).toHaveValue('half-written reply')
})

test('the notification ask in the sidebar: Allow asks the browser once; × dismisses it for good', async ({ page, minbox }) => {
  await page.addInitScript(() => {
    let perm = 'default'
    const N = function () {} as any
    Object.defineProperty(N, 'permission', { get: () => perm })
    N.requestPermission = async () => ((perm = 'granted'), perm)
    ;(window as any).Notification = N
  })
  await page.goto(minbox.url)
  const ask = page.getByTestId('sidebar').getByText('Notify you when Claude asks something?')
  await expect(ask).toBeVisible()
  await page.getByTestId('sidebar').getByRole('button', { name: 'Allow' }).click()
  await expect(ask).toHaveCount(0)
  expect(await page.evaluate(() => [Notification.permission, localStorage.getItem('minbox:notify-asked')])).toEqual(['granted', '1'])
  // Asked once: not again (this stand-in forgets the grant on a reload, the key does not).
  await page.reload()
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(ask).toHaveCount(0)
  // × dismisses it for good.
  await page.evaluate(() => localStorage.removeItem('minbox:notify-asked'))
  await page.reload()
  await expect(ask).toBeVisible()
  await page.getByTestId('sidebar').getByRole('button', { name: 'Dismiss' }).click()
  await expect(ask).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('board')).toBeVisible()
  await expect(ask).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the terminal takes the whole screen; × goes back to the stream', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'alpha')
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    await expect(page.getByTestId('composer-text')).toBeVisible()
    await page.getByTestId('terminal-toggle').tap()
    await expect(page.getByTestId('terminal')).toBeVisible()
    await expect(page.getByTestId('composer-text')).toBeHidden()
    const t = await box(page, 'terminal')
    expect(t.width).toBeGreaterThan(390 - 80)
    expect(t.height).toBeGreaterThan(300)
    await noOverflow(page)
    await page.getByTestId('terminal-close').tap()
    await expect(page.getByTestId('terminal')).toHaveCount(0)
    await expect(page.getByTestId('composer-text')).toBeVisible()
    // A phone starts on the stream after a reload.
    await page.reload()
    await expect(page.getByTestId('composer-text')).toBeVisible()
  })

  test('the project sheet (Agents tab) scopes the list and has Settings', async ({ page, minbox }) => {
    await startAgent(minbox, 'api-agent', 'api')
    await startAgent(minbox, 'web-agent', 'web')
    await page.goto(minbox.url)
    await page.getByTestId('tab-agents').tap()
    await expect(page.getByTestId('agent-row')).toHaveCount(2)
    await page.getByTestId('project-switch').tap()
    await expect(page.getByTestId('project-sheet')).toBeVisible()
    await page.getByTestId('project-item').filter({ hasText: 'web' }).getByTestId('project-select').tap()
    await expect(page.getByTestId('project-sheet')).toBeHidden()
    await expect(page.getByTestId('agent-row')).toHaveCount(1)
    await expect(page.getByTestId('agent-row')).toContainText('web-agent')
    await expect(page.getByTestId('project-switch-name')).toHaveText('web')
    await page.getByTestId('project-switch').tap()
    await page.getByTestId('project-sheet').getByTestId('open-settings').tap()
    await expect(page).toHaveURL(/v=settings/)
  })
})

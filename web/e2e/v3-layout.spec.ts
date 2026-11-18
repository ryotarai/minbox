// The v3 shell's layout, as main had it (narrow.spec, terminal-toggle.spec, files-pane.spec's ⇧F,
// v2.spec's resizable edges and swapped panes, projects.spec's phone sheet, the notification ask):
// the side pane is kept across agents and reloads, edges drag and keep their widths, Settings › swap
// panes, the tablet's two panes, the phone's full-screen terminal and project sheet.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { api, startAgent } from './v3'

const box = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())!
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)

test('the terminal pane stays open across agents and a reload; ⇧F shows the files and back', async ({ page, minbox }) => {
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

  await page.getByTestId('stream-view').locator('.v-scroll').click()
  await page.keyboard.press('Shift+F')
  await expect(page.getByTestId('pane-files')).toHaveClass(/on/)
  await expect(page.getByTestId('v3-app')).toHaveAttribute('data-pane', 'files')
  await page.keyboard.press('Shift+F')
  await expect(page.getByTestId('pane-tasks')).toHaveClass(/on/)
  await page.reload()
  await expect(page.getByTestId('pane-tasks')).toHaveClass(/on/)
  void b
})

test('the side pane and sidebar edges drag; the widths are kept; swapped panes put the side pane on the left', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  const side0 = await box(page, 'agent-side')
  const rz = await box(page, 'side-resizer')
  await page.mouse.move(rz.x + rz.width / 2, rz.y + 200)
  await page.mouse.down()
  await page.mouse.move(rz.x + rz.width / 2 - 60, rz.y + 200, { steps: 4 })
  await page.mouse.move(rz.x + rz.width / 2 - 120, rz.y + 200, { steps: 4 })
  await page.mouse.up()
  const side1 = await box(page, 'agent-side')
  expect(Math.abs(side1.width - (side0.width + 120))).toBeLessThan(4)

  const sb0 = await box(page, 'sidebar')
  const srz = await box(page, 'sidebar-resizer')
  await page.mouse.move(srz.x + srz.width / 2, 300)
  await page.mouse.down()
  await page.mouse.move(srz.x + srz.width / 2 + 50, 300, { steps: 5 })
  await page.mouse.up()
  const sb1 = await box(page, 'sidebar')
  expect(Math.abs(sb1.width - (sb0.width + 50))).toBeLessThan(4)

  await page.reload()
  expect(Math.abs((await box(page, 'agent-side')).width - side1.width)).toBeLessThan(2)
  expect(Math.abs((await box(page, 'sidebar')).width - sb1.width)).toBeLessThan(2)

  // The terminal (a wide pane) keeps a width of its own.
  await page.getByTestId('terminal-toggle').click()
  const wide = await box(page, 'agent-side')
  expect(wide.width).toBeGreaterThan(side1.width)

  // Settings › swap panes: the side pane on the left of the stream; its edge drags the other way.
  await api(minbox, 'PUT', '/api/settings', { swap_panes: false })
  await page.reload()
  const s2 = await box(page, 'agent-side')
  const v2 = await box(page, 'stream-view')
  expect(s2.x + s2.width).toBeLessThanOrEqual(v2.x + 1)
  const rz2 = await box(page, 'side-resizer')
  await page.mouse.move(rz2.x + rz2.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(rz2.x + rz2.width / 2 + 40, 400, { steps: 4 })
  await page.mouse.up()
  expect(Math.abs((await box(page, 'agent-side')).width - (s2.width + 40))).toBeLessThan(4)
})

for (const width of [700, 900, 1099]) {
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
    await page.getByTestId('terminal-toggle').click()
    await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
    const s = await box(page, 'stream-view')
    const t = await box(page, 'agent-side')
    expect(s.width).toBeGreaterThanOrEqual(300)
    expect(t.width).toBeGreaterThanOrEqual(240)
    expect(t.x).toBeGreaterThanOrEqual(s.x + s.width - 1)
    await noOverflow(page)

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

// Agents (sessions) in v3, as main had them (restart.spec, v2.spec's session menu, threads-first's
// session list, session-kinds' shells, mod-connection's phone badge): the agent header's actions
// (menu: rename, set as main, restart, stop, archive, delete; Resume), the agents list grouped by
// project with the row menu, the New agent dialog (kind, folder, host), plain shells listed.
import { createSession, createShellSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'
import { api, startAgent } from './v3'

const row = (page: import('@playwright/test').Page, name: string) => page.getByTestId('agent-row').filter({ has: page.locator('.v-nm', { hasText: name }) })

test('the agent menu restarts a running agent (after a confirm); the new process gets messages', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'cycler')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say before')
  await expectTerminal(page, 'sent in')

  // Declining the confirm leaves it as it is.
  page.once('dialog', (d) => void d.dismiss())
  await page.getByTestId('agent-menu').click()
  await page.getByTestId('menu-restart').click()
  await page.waitForTimeout(800)
  expect(minbox.log).not.toMatch(/spawn session=\S+ resume=true/)

  page.once('dialog', (d) => void d.accept())
  await page.getByTestId('menu-restart').click()
  await expect.poll(() => minbox.log, { timeout: 20_000 }).toMatch(/modconn: spawn session=\S+ resume=true/)
  await expect(page.getByTestId('agent-resume')).toHaveCount(0)
  // A message sent afterwards reaches the new process.
  await expect.poll(() => terminalText(page), { timeout: 20_000 }).toMatch(/ready>/)
  await page.getByTestId('composer-text').fill('Hello again')
  await page.getByTestId('composer-send').click()
  await expectTerminal(page, '<<< inbox')
  await expectTerminal(page, 'Hello again')
})

test('stop ends the agent; Resume in its header starts it again; archive (with Undo) and delete from the menu', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'stopper')
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('agent-state')).toHaveText('idle')
  await page.getByTestId('agent-menu').click()
  await page.getByTestId('menu-stop').click()
  await expect(page.getByTestId('agent-state')).toHaveText('ended', { timeout: 15_000 })
  await expect(row(page, 'stopper')).toContainText('ended')
  await page.getByTestId('agent-resume').click()
  await expect(page.getByTestId('agent-state')).not.toHaveText('ended', { timeout: 15_000 })
  await expect(page.getByTestId('agent-resume')).toHaveCount(0)

  // Archive needs it stopped; Z undoes it.
  await page.getByTestId('agent-menu').click()
  await expect(page.getByTestId('menu-archive')).toBeDisabled()
  await page.getByTestId('menu-stop').click()
  await expect(page.getByTestId('agent-state')).toHaveText('ended', { timeout: 15_000 })
  await page.getByTestId('agent-menu').click()
  await page.getByTestId('menu-archive').click()
  await expect(row(page, 'stopper')).toHaveCount(0)
  await page.getByTestId('nav-board').click()
  await page.keyboard.press('z')
  await expect(row(page, 'stopper')).toHaveCount(1)

  // Delete asks first.
  await row(page, 'stopper').click()
  await page.getByTestId('agent-menu').click()
  await page.getByTestId('menu-delete').click()
  await expect(page.getByRole('dialog')).toContainText('stopper')
})

test('rename from the menu, by double-clicking the row, and from the palette; set another main agent; the row menu', async ({ page, minbox }) => {
  const one = await startAgent(minbox, 'one')
  const two = await startAgent(minbox, 'two')
  await page.goto(minbox.url + `/#v=agent&s=${two.id}`)
  await expect(row(page, 'one')).toContainText('main')
  await expect(row(page, 'two')).not.toContainText('main ·')

  await page.getByTestId('agent-menu').click()
  await page.getByTestId('menu-rename').click()
  await page.getByTestId('rename-input').fill('second')
  await page.getByTestId('rename-input').press('Enter')
  await expect(page.getByTestId('agent-name')).toContainText('second')
  await expect(row(page, 'second')).toHaveCount(1)

  // Set as main: the main marker moves.
  await page.getByTestId('agent-menu').click()
  await page.getByTestId('menu-set-main').click()
  await expect(row(page, 'second')).toContainText('main')
  await expect.poll(async () => (await api(minbox, 'GET', '/api/sessions')).find((s: any) => s.id === two.id).is_main).toBe(true)

  // Double-click the row.
  await row(page, 'one').dblclick()
  await page.getByTestId('rename-input').fill('first')
  await page.getByTestId('rename-input').press('Enter')
  await expect(row(page, 'first')).toHaveCount(1)

  // Right-click: the same menu at the row.
  await row(page, 'first').click({ button: 'right' })
  await expect(page.getByTestId('session-context-menu')).toBeVisible()
  await page.getByTestId('session-context-menu').getByTestId('menu-rename').click()
  await page.getByTestId('rename-input').fill('uno')
  await page.getByTestId('rename-input').press('Enter')
  await expect.poll(async () => (await api(minbox, 'GET', '/api/sessions')).find((s: any) => s.id === one.id).name).toBe('uno')
})

test('all projects: the agents are grouped under their project; one project shows only its own', async ({ page, minbox }) => {
  await startAgent(minbox, 'api-agent', 'api')
  await startAgent(minbox, 'web-agent', 'web')
  await page.goto(minbox.url)
  const groups = page.getByTestId('agent-group')
  await expect(groups).toHaveCount(2)
  await expect(page.getByTestId('agent-group-name')).toHaveCount(2)
  await expect(groups.filter({ hasText: 'api-agent' }).getByTestId('agent-group-name')).toHaveText('api')
  await expect(groups.filter({ hasText: 'web-agent' }).getByTestId('agent-group-name')).toHaveText('web')
  await page.locator('[data-testid="project-select"][title^="web"]').click()
  await expect(page.getByTestId('agent-row')).toHaveCount(1)
  await expect(page.getByTestId('agent-group-name')).toHaveCount(0)
})

test('New agent: the full dialog (folder, name) from the sidebar starts an agent and opens its terminal', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await page.getByTestId('sidebar-new-agent').click()
  const dlg = page.getByRole('dialog', { name: 'New session' })
  await expect(dlg).toBeVisible()
  await page.getByTestId('new-session-cwd').fill(minbox.dataDir)
  await page.getByTestId('new-session-name').fill('fresh')
  await expect(page.getByTestId('new-session-missing')).toHaveCount(0)
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await expect(page.getByTestId('agent-name')).toContainText('fresh')
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expectTerminal(page, 'ready>')

  // From the New message dialog's New agent… choice too.
  await page.keyboard.press('Escape')
  await page.getByTestId('sidebar-new').click()
  await page.getByTestId('new-to').selectOption('new')
  await page.getByTestId('new-agent-options').click()
  await expect(dlg).toBeVisible()
  await expect(page.getByTestId('new-session-project')).toBeVisible()
})

test('a plain shell an older build left is listed under Shells and opens on its terminal', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createShellSession(page, minbox, 'oldshell')
  await page.goto(minbox.url)
  const shells = page.getByTestId('shell-group')
  await expect(shells).toBeVisible()
  await expect(shells.getByTestId('agent-row')).toContainText('oldshell')
  await expect(shells.getByTestId('agent-row')).toContainText('shell')
  await shells.getByTestId('agent-row').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('oldshell')
  await typeInTerminal(page, 'echo from-the-shell')
  await expectTerminal(page, /^from-the-shell$/m)
})

test('the mod connection badge is in the agent header and goes stale', async ({ page, connMinbox: minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'beater')
  await expectTerminal(page, 'ready>')
  const badge = page.getByTestId('agent-actions').getByTestId('mod-conn')
  await expect(badge).toHaveAttribute('data-state', 'connected')
  await typeInTerminal(page, 'nobeat')
  await expect(badge).toHaveAttribute('data-state', 'stale', { timeout: 15_000 })
  await badge.click()
  await expect(page.getByTestId('mod-conn-details')).toBeVisible()
  await page.keyboard.press('Escape')
  await typeInTerminal(page, 'beat')
  await expect(badge).toHaveAttribute('data-state', 'connected', { timeout: 15_000 })
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('the badge and the agent menu are in the stream header; the Agents tab has New agent', async ({ page, connMinbox: minbox }) => {
    const a = await startAgent(minbox, 'pocketbeat')
    await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
    const badge = page.getByTestId('agent-actions').getByTestId('mod-conn')
    await expect(badge).toHaveAttribute('data-state', 'connected')
    await expect(badge).toBeInViewport()
    await page.getByTestId('agent-menu').tap()
    await expect(page.getByTestId('menu-restart')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('tab-agents').tap()
    await page.getByTestId('agents-new-agent').tap()
    await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible()
  })
})

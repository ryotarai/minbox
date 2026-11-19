// Picking another project (the rail, the palette) never leaves the previous project's task or agent
// on screen: the selection and what the main pane shows always agree. In All agents
// (#v=alltasks&k=…) a task of the old project is unpicked ("Select a task", nothing of it shown); an
// agent of the old project open (with a task picked) is left for the new project's Board.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { api, say, startAgent, type Agent } from './v3'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function setup(minbox: Parameters<typeof startAgent>[0]) {
  const a = await startAgent(minbox, 'alpha-agent', 'alpha')
  const b = await startAgent(minbox, 'beta-agent', 'beta')
  const task = (ag: Agent, title: string) => api(minbox, 'POST', '/api/v3/tasks', { project_id: ag.project_id, title, session_id: ag.id })
  const ta = await task(a, 'Alpha gauge task')
  const tb = await task(b, 'Beta login task')
  await say(minbox, a, 'alpha secret words', [ta.id])
  await say(minbox, b, 'beta plain words', [tb.id])
  return { a, b, ta, tb }
}

const item = (page: Page, id: string) => page.locator(`[data-testid="project-item"][data-project-id="${id}"]`)

async function pickInPalette(page: Page, dir: string) {
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('palette-input')).toBeFocused()
  await page.getByTestId('palette-input').fill('!' + dir)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('palette')).toHaveCount(0)
}

for (const via of ['rail', 'palette'] as const) {
  test(`All agents: switching project (${via}) unpicks the old project's task`, async ({ page, minbox }) => {
    const { a, b, ta, tb } = await setup(minbox)
    await page.setViewportSize({ width: 1400, height: 860 })
    await page.goto(minbox.url + `/#v=alltasks`)
    await item(page, a.project_id).getByTestId('project-select').click()
    await expect(item(page, a.project_id)).toHaveAttribute('data-selected', 'true')

    const pane = page.getByTestId('tasks-pane')
    await pane.locator(`[data-testid="agent-task"][data-task="${ta.id}"]`).click()
    await expect(page).toHaveURL(new RegExp(`k=${ta.id}`))
    const view = page.getByTestId('all-agents-view')
    await expect(view.getByText('alpha secret words')).toBeVisible()

    if (via === 'rail') await item(page, b.project_id).getByTestId('project-select').click()
    else await pickInPalette(page, 'beta')
    await expect(item(page, b.project_id)).toHaveAttribute('data-selected', 'true')
    await expect(page).toHaveURL(/#v=alltasks/)
    await expect(page).not.toHaveURL(/[&#]k=/)
    await expect(view.getByTestId('all-agents-empty')).toHaveText('Select a task')
    await expect(view).not.toHaveAttribute('data-detail', /.+/)
    await expect(page.getByTestId('agent-task-detail')).toHaveCount(0)
    await expect(page.getByText('alpha secret words')).toHaveCount(0)
    await expect(page.getByText('Alpha gauge task')).toHaveCount(0)
    await expect(pane.locator('[data-testid="agent-task"][aria-current="true"], [data-testid="agent-task"].sel')).toHaveCount(0)
    await expect(pane.locator(`[data-testid="agent-task"][data-task="${tb.id}"]`)).toBeVisible()

    // All projects again: nothing picked comes back by itself.
    await page.getByTestId('project-all').click()
    await expect(page.getByText('alpha secret words')).toHaveCount(0)
  })

  test(`an agent with a task open: switching project (${via}) leaves nothing of the old project`, async ({ page, minbox }) => {
    const { a, b, ta } = await setup(minbox)
    await page.setViewportSize({ width: 1400, height: 860 })
    await page.goto(minbox.url + `/#v=agent&s=${a.id}&k=${ta.id}`)
    // The agent's project picked (All projects is the default; picking it keeps the agent open).
    await item(page, a.project_id).getByTestId('project-select').click()
    await expect(item(page, a.project_id)).toHaveAttribute('data-selected', 'true')
    await expect(page).toHaveURL(new RegExp(`s=${a.id}.*k=${ta.id}|k=${ta.id}.*s=${a.id}`))
    await expect(page.getByText('alpha secret words').first()).toBeVisible()

    if (via === 'rail') await item(page, b.project_id).getByTestId('project-select').click()
    else await pickInPalette(page, 'beta')
    await expect(item(page, b.project_id)).toHaveAttribute('data-selected', 'true')
    await expect(page).not.toHaveURL(new RegExp(`s=${a.id}`))
    await expect(page).not.toHaveURL(/[&#]k=/)
    await expect(page.getByText('alpha secret words')).toHaveCount(0)
    await expect(page.getByText('Alpha gauge task')).toHaveCount(0)
    await expect(page.getByTestId('agent-row')).toHaveCount(1)
    await expect(page.getByTestId('agent-row')).toContainText('beta-agent')
  })
}

// The projects rail (far left): clicking a project selects it, from any view, also while an agent
// of another project is open (the rail used to snap back to the open agent's project).
import { expect, test } from './fixtures'
import { startAgent } from './v3'

test('the projects rail selects any project, also while an agent of another project is open', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha-agent', 'alpha')
  const b = await startAgent(minbox, 'beta-agent', 'beta')
  const item = (id: string) => page.locator(`[data-testid="project-item"][data-project-id="${id}"]`)

  // From the Board: each project in turn.
  await page.goto(minbox.url)
  await expect(page.getByTestId('project-item')).toHaveCount(2)
  for (const p of [a.project_id, b.project_id, a.project_id]) {
    await item(p).getByTestId('project-select').click()
    await expect(item(p)).toHaveAttribute('data-selected', 'true')
  }

  // With an agent of alpha open: picking beta selects beta and leaves alpha's agent.
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(item(a.project_id)).toHaveAttribute('data-selected', 'true')
  await item(b.project_id).getByTestId('project-select').click()
  await expect(item(b.project_id)).toHaveAttribute('data-selected', 'true')
  await expect(item(a.project_id)).toHaveAttribute('data-selected', 'false')
  await expect(page).not.toHaveURL(new RegExp(`s=${a.id}`))
  await expect(page.getByTestId('agent-row')).toHaveCount(1)
  await expect(page.getByTestId('agent-row')).toContainText('beta-agent')
})

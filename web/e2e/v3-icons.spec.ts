// The icons are Lucide SVGs (components/icons.tsx): the sidebar's entries, the agent's header buttons and
// the Tasks pane's fold button draw an svg, not a glyph character.
import { expect, test } from './fixtures'
import { startAgent } from './v3'

test('toolbar buttons render Lucide svg icons', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('stream-view')).toBeVisible()
  for (const id of ['nav-board', 'nav-search', 'open-palette', 'shell-toggle', 'files-toggle', 'tasks-pane-toggle']) {
    await expect(page.getByTestId(id).locator('svg.lucide').first(), id).toBeVisible()
  }
  await expect(page.getByTestId('nav-board')).toHaveText(/^\s*Board\s*$/)
})

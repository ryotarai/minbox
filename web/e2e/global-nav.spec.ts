import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test } from './fixtures'

// Settings, Tasks, Decide and Drafts are not about the thread list: they sit at the bottom of the
// project rail (desktop, tablet) and of the project sheet (phone). The list's ⋯ menu keeps only its
// own display options. SHOTS_DIR=... writes a screenshot of each place.

const shot = async (page: Page, name: string) => {
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/${name}.png` })
}

async function enableAll(url: string) {
  await fetch(url + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ topics: true, decision_mode: true }),
  })
}

test('desktop: Settings is in the project rail in both modes, not in the list menu', async ({ page, minbox }) => {
  await enableAll(minbox.url)
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'nav')
  await expectTerminal(page, 'ready>')
  const rail = page.getByTestId('project-rail')

  for (const mode of ['names', 'tiles'] as const) {
    if ((await rail.getAttribute('data-mode')) !== mode) await page.getByTestId('project-rail-toggle').click()
    await expect(rail).toHaveAttribute('data-mode', mode)
    const footer = rail.getByTestId('rail-global')
    for (const id of ['open-settings', 'open-tasks', 'open-decide', 'drafts']) await expect(footer.getByTestId(id)).toBeVisible()
    await expect(footer.getByRole('button', { name: 'Settings' })).toBeVisible()
    // The footer sits at the bottom of the rail, just above New project and the mode toggle.
    const r = (await rail.boundingBox())!
    const f = (await footer.boundingBox())!
    expect(f.y + f.height).toBeGreaterThan(r.y + r.height - 130)
    if (mode === 'names') await expect(footer.getByTestId('open-settings')).toContainText('Settings')
    else await expect(footer.getByTestId('open-settings')).toHaveAttribute('title', 'Settings')
    await shot(page, `rail-${mode}`)
  }

  // The list menu holds only the display options.
  await page.getByTestId('list-options').click()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Compact rows' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Settings|Tasks|Decide|Drafts/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await rail.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-back')).toBeVisible()
  await page.getByTestId('settings-back').click()
  await rail.getByTestId('open-tasks').click()
  await expect(page.getByTestId('topics-col-waiting_on_you')).toBeVisible()
})

test('tablet: Settings is in the project tiles', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'tab')
  await expect(page.getByTestId('tablet')).toBeVisible()
  await page.getByTestId('project-rail').getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-back')).toBeVisible()
})

test('phone: Settings is two taps away, on the project sheet', async ({ page, minbox }) => {
  await enableAll(minbox.url)
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'ph')
  await expectTerminal(page, 'ready>')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toBeVisible()

  await page.getByTestId('list-options').click()
  await expect(page.getByRole('menuitemcheckbox', { name: 'Compact rows' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: /Settings|Tasks|Decide|Drafts/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByTestId('project-switch').click()
  const sheet = page.getByTestId('project-sheet')
  for (const id of ['open-settings', 'open-tasks', 'open-decide', 'drafts']) await expect(sheet.getByTestId('sheet-global').getByTestId(id)).toBeVisible()
  await shot(page, 'phone-projects')
  await sheet.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-back')).toBeVisible()
  await expect(page.getByTestId('project-sheet')).toHaveCount(0)
})

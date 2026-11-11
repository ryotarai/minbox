import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Settings › Integrations › Linear › "Auto-fill: extra prompt" reaches the helper that pre-fills the
// Create-issue dialog (the fake helper echoes it into the description). Fake Linear only.

test('Linear auto-fill extra prompt: edit, counter, reset, save, and its effect on the dialog', async ({ page, minbox }) => {
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })

  const text = page.getByTestId('linear-extra-text')
  const save = page.getByTestId('linear-extra-save')
  const reset = page.getByTestId('linear-extra-reset')
  await expect(text).toHaveValue('')
  await expect(save).toBeDisabled()
  await expect(page.getByTestId('linear-extra-count')).toHaveText('0 / 4000')

  // dirty: counter moves, Reset restores, Save enabled
  await text.fill('Write titles in English')
  await expect(page.getByTestId('linear-extra-count')).toHaveText('23 / 4000')
  await expect(save).toBeEnabled()
  await reset.click()
  await expect(text).toHaveValue('')
  await expect(save).toBeDisabled()

  // over the limit: Save disabled
  await text.fill('x'.repeat(4001))
  await expect(save).toBeDisabled()
  await text.fill('Always add label agent.')
  await save.click()
  await expect(save).toBeDisabled() // clean again
  await page.reload()
  await expect(page.getByTestId('linear-extra-text')).toHaveValue('Always add label agent.')

  // the Create dialog's draft shows the effect
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'lin-extra')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Working on the login bug')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).first().click()
  await page.getByTestId('linear-create-open').click()
  await expect(page.getByTestId('linear-create-desc')).toHaveValue(/Extra prompt seen: Always add label agent\./, { timeout: 15_000 })
})

// The Create dialog says which of Linear's lists failed (visible Details, not a tooltip), counts the
// teams it loaded, and Reload lists refetches them (bypassing the server cache). Fake Linear only.
test('Create Linear issue: warning details are visible and Reload lists refetches', async ({ page, minbox }) => {
  const lin = minbox.linear
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'lin-warn')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Working on the login bug')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).first().click()

  lin.failLabels = true
  await page.getByTestId('linear-create-open').click()
  await expect(page.getByTestId('linear-create-counts')).toHaveText('2 teams loaded, 1 project', { timeout: 15_000 })
  const warnings = page.getByTestId('linear-create-warnings')
  await expect(warnings).toBeVisible({ timeout: 15_000 }) // open by default, no hover needed
  await expect(warnings).toContainText('list_issue_labels of Engineering')
  await expect(warnings).toContainText('labels are down')
  await expect(page.getByTestId('linear-create-lists-summary')).toContainText('list_teams [list_teams]: 1 page(s), 2 items, 2 parsed')
  await expect(page.getByTestId('linear-create-team').locator('option')).toHaveCount(3)

  // Linear recovers; Reload lists refetches and the warning goes away.
  lin.failLabels = false
  const before = lin.calls.filter((c) => c.tool === 'list_teams').length
  await page.getByTestId('linear-create-reload').click()
  await expect(page.getByTestId('linear-create-warnings')).toHaveCount(0)
  expect(lin.calls.filter((c) => c.tool === 'list_teams').length).toBeGreaterThan(before)
})

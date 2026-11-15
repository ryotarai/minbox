import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// A thread's short name: no "+ name" chip in the header when unset; "Set name…" / "Edit name…" in
// the "…" menu and the row's context menu; the name chip, once set, still edits in place.

test('thread short name: set from the menus, chip shown only when set', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  const row = page.getByTestId('thread-list').getByTestId('thread-row').filter({ hasText: 'Pick a database' })
  await row.click()
  const view = page.getByTestId('thread-view')
  await expect(view.getByTestId('thread-subject')).toBeVisible()
  await expect(view.getByText('+ name')).toHaveCount(0)

  // "…" menu: Set name…
  await page.getByTestId('thread-more').click()
  await expect(page.getByTestId('thread-rename')).toHaveText('Set name…')
  await page.getByTestId('thread-rename').click()
  const input = page.getByRole('menu').getByLabel('Thread name')
  await expect(input).toBeFocused()
  await input.fill('db pick')
  await input.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(view.getByRole('button', { name: 'db-pick', exact: true })).toBeVisible()

  // The row's context menu: Edit name…
  await row.click({ button: 'right' })
  const ctx = page.getByTestId('thread-context-menu')
  await expect(ctx.getByTestId('thread-rename')).toHaveText('Edit name…')
  await ctx.getByTestId('thread-rename').click()
  const input2 = ctx.getByLabel('Thread name')
  await expect(input2).toHaveValue('db-pick')
  await input2.fill('db-choice')
  await input2.press('Enter')
  await expect(ctx).toHaveCount(0)
  const chip = view.getByRole('button', { name: 'db-choice', exact: true })
  await expect(chip).toBeVisible()

  // The chip still edits in place.
  await chip.click()
  const inline = view.getByLabel('Thread name')
  await inline.fill('final')
  await inline.press('Enter')
  await expect(view.getByRole('button', { name: 'final', exact: true })).toBeVisible()
})

import type { Page } from '@playwright/test'
import { createSession, expect, test, type Minbox } from './fixtures'

// Linking a thread to a Linear issue from the "+ Linear" button left of the thread's meta line:
// a dialog that searches the fake Linear as you type, keyboard picking, the linked identifier in
// the meta line, "New issue" opening the Create dialog with the search text, and the phone sheet.
// No real Linear is ever contacted. LINEAR_LINK_SHOTS=<dir> saves screenshots.

const SHOTS = process.env.LINEAR_LINK_SHOTS

async function connectAndSeed(page: Page, minbox: Minbox, name: string) {
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, name)
  const sessions = await (await page.request.get(minbox.url + '/api/sessions')).json()
  const sess = sessions[0]
  const r = await page.request.post(`${minbox.url}/api/sessions/${sess.id}/threads`, { data: { subject: 'Seeded', body: 'Seeded request about the login bug' } })
  expect(r.ok()).toBe(true)
  const thr = (await r.json()).id as string
  await page.goto(`${minbox.url}/#s=${sess.id}&t=${thr}`)
  await expect(page.getByTestId('thread-subject')).toHaveText('Seeded')
  return thr
}

const searches = (minbox: Minbox) => minbox.linear.calls.filter((c) => c.tool === 'list_issues' && c.args.query).map((c) => c.args.query as string)

test('link a Linear issue from the meta line: incremental search, keyboard pick, new issue prefilled', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await connectAndSeed(page, minbox, 'lin-link')

  // The button sits immediately left of "N messages · X min", on the same line; the old buttons are gone.
  const open = page.getByTestId('linear-link-open')
  const meta = page.getByTestId('thread-meta')
  await expect(open).toBeVisible()
  await expect(open).toHaveAttribute('aria-label', 'Link Linear issue')
  await expect(page.getByTestId('linear-create-open')).toHaveCount(0)
  const ob = (await open.boundingBox())!
  const mb = (await meta.boundingBox())!
  expect(ob.x + ob.width).toBeLessThanOrEqual(mb.x)
  expect(mb.x - (ob.x + ob.width)).toBeLessThan(16)
  expect(Math.abs(ob.y + ob.height / 2 - (mb.y + mb.height / 2))).toBeLessThan(4)
  if (SHOTS) await page.locator('[data-testid="thread-subject"]').locator('..').screenshot({ path: `${SHOTS}/linear-link-meta.png` })

  // The dialog: focused search, a hint for the empty query (Linear is not asked).
  await open.click()
  const dialog = page.getByRole('dialog', { name: 'Link Linear issue' })
  const input = page.getByTestId('linear-link-search')
  await expect(input).toBeFocused()
  await expect(page.getByTestId('linear-link-hint')).toBeVisible()
  await expect(page.getByTestId('linear-link-new')).toHaveText('New issue')
  expect(searches(minbox)).toEqual([])

  // Typing filters the results as you go (debounced: one search per pause, not per key).
  await input.pressSequentially('safari', { delay: 20 })
  const results = page.getByTestId('linear-link-result')
  await expect(results).toHaveCount(1)
  await expect(results.first()).toHaveAttribute('data-identifier', 'ENG-201')
  await expect(results.first()).toContainText('Safari login returns 500')
  await expect(results.first()).toContainText('In Progress')
  expect(searches(minbox)).toEqual(['safari'])
  await input.fill('eng')
  await expect(results).toHaveCount(5) // ENG-201..204 and ENG-123
  await expect(page.getByTestId('linear-link-new')).toContainText('New issue “eng”')
  await expect(results.first()).toHaveAttribute('aria-selected', 'true')
  if (SHOTS) await dialog.screenshot({ path: `${SHOTS}/linear-link-dialog.png` })
  await input.fill('zzz')
  await expect(page.getByTestId('linear-link-empty')).toContainText('No issues match “zzz”')

  // An exact identifier comes first; ↓ moves, Enter links it; the dialog closes and the thread shows it.
  await input.fill('dark mode')
  await expect(results).toHaveCount(1)
  await input.fill('ENG-123')
  await expect(results.first()).toHaveAttribute('data-identifier', 'ENG-123')
  await input.fill('eng')
  await expect(results).toHaveCount(5)
  await input.press('ArrowDown')
  await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true')
  const second = (await results.nth(1).getAttribute('data-identifier'))!
  await input.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByText(`Linked ${second}`)).toBeVisible()
  await expect(page.getByTestId('linear-meta-issue')).toHaveText(second)
  await expect(page.getByTestId('linear-chip')).toContainText(second)
  if (SHOTS) await page.locator('[data-testid="thread-subject"]').locator('..').screenshot({ path: `${SHOTS}/linear-link-meta-linked.png` })

  // The "+" next to the identifier links a different one by click.
  await page.getByTestId('linear-link-open').click()
  await input.fill('refactor')
  await expect(results).toHaveCount(1)
  await results.first().click()
  await expect(page.getByTestId('linear-meta-issue')).toHaveText('ENG-203')

  // "New issue" (↑ from the first row wraps to it) opens Create with the search text as the title.
  await page.getByTestId('linear-link-open').click()
  await input.fill('Brand new problem')
  await expect(page.getByTestId('linear-link-empty')).toBeVisible()
  await input.press('ArrowUp')
  await expect(page.getByTestId('linear-link-new')).toHaveAttribute('aria-selected', 'true')
  await input.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('linear-create-title')).toHaveValue('Brand new problem')
  // The helper's draft does not replace it.
  await expect(page.getByTestId('linear-create-drafting')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('linear-create-title')).toHaveValue('Brand new problem')
})

test('link dialog: a failing search shows the error; Escape closes', async ({ page, minbox }) => {
  await connectAndSeed(page, minbox, 'lin-link-err')
  minbox.linear.failList = true
  await page.getByTestId('linear-link-open').click()
  await page.getByTestId('linear-link-search').fill('anything')
  await expect(page.getByTestId('linear-link-search-error')).toContainText('issues are down')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Link Linear issue' })).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('phone: the button opens a bottom sheet; tapping a result links it', async ({ page, minbox }) => {
    await connectAndSeed(page, minbox, 'lin-link-phone')
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
    await page.getByTestId('linear-link-open').tap()
    const dialog = page.getByRole('dialog', { name: 'Link Linear issue' })
    await expect(dialog).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(Math.abs(box.y + box.height - 844)).toBeLessThanOrEqual(2) // a sheet at the bottom edge
    await page.getByTestId('linear-link-search').fill('dark')
    const results = page.getByTestId('linear-link-result')
    await expect(results).toHaveCount(1)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/linear-link-dialog-phone.png` })
    await results.first().tap()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('linear-chip')).toContainText('ENG-202')
  })
})

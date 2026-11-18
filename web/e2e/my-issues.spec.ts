import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, type Minbox } from './fixtures'
import { startAgent } from './v3'

// My issues: the Linear issues assigned to me (list, detail), starting a linked thread from one, and
// creating an issue from plain language. Against the fake Linear (OAuth + MCP) on loopback.

const SHOTS = process.env.ISSUES_SHOTS // a folder: dark-theme screenshots for review

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') })
}

async function connect(page: Page, minbox: Minbox) {
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await expect(page.getByTestId('linear-status')).toHaveText('Not connected')
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })
}

test('desktop: entry above All projects only when connected; list, search, detail; start a linked thread; new issue from plain language', async ({ page, minbox }) => {
  test.setTimeout(150_000)
  if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
  const lin = minbox.linear
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  // Not connected: no entry.
  await expect(page.getByTestId('project-all')).toBeVisible()
  await expect(page.getByTestId('my-issues')).toHaveCount(0)

  await connect(page, minbox)
  await page.goto(minbox.url)
  const entry = page.getByTestId('my-issues')
  await expect(entry).toBeVisible()
  await expect(entry).toHaveAttribute('aria-label', 'My issues')
  const a = (await entry.boundingBox())!
  const b = (await page.getByTestId('project-all').boundingBox())!
  expect(a.y).toBeLessThan(b.y)

  await entry.click()
  await expect(page).toHaveURL(/v=issues/)
  await expect(page.getByTestId('issues-screen')).toBeVisible()
  // Open issues, grouped by state with counts; closed ones are hidden until asked for.
  await expect(page.getByTestId('issue-row')).toHaveCount(3)
  const groups = page.getByTestId('issue-group')
  await expect(groups).toHaveCount(3)
  await expect(groups.nth(0)).toHaveAttribute('data-state', 'In Progress')
  await expect(groups.nth(1)).toHaveAttribute('data-state', 'Todo')
  await expect(groups.nth(2)).toHaveAttribute('data-state', 'Backlog')
  await expect(groups.nth(0).getByTestId('issue-group-count')).toHaveText('1')
  await expect(page.getByTestId('issue-row').filter({ hasText: 'Old shipped thing' })).toHaveCount(0)
  await page.getByTestId('issues-closed').check()
  await expect(page.getByTestId('issue-row')).toHaveCount(4)
  await page.getByTestId('issues-closed').uncheck()
  // Search is client-side.
  await page.getByTestId('issues-search').fill('dark')
  await expect(page.getByTestId('issue-row')).toHaveCount(1)
  await expect(page.getByTestId('issue-row')).toContainText('ENG-202')
  await page.getByTestId('issues-search').fill('nothing like this')
  await expect(page.getByTestId('issues-none')).toBeVisible()
  await page.getByTestId('issues-search').fill('')
  await expect(page.getByTestId('issue-row')).toHaveCount(3)
  const row201 = page.getByTestId('issue-row').filter({ hasText: 'ENG-201' })
  await expect(row201).toContainText('Safari login returns 500')
  await expect(row201).toContainText('Bug')
  await expect(row201.locator('[data-priority="1"]')).toBeVisible()
  await shot(page, 'issues-list-desktop')

  // Detail: the selection is in the URL and survives a reload.
  await row201.click()
  await expect(page).toHaveURL(/issue=ENG-201/)
  const detail = page.getByTestId('issue-detail')
  await expect(page.getByTestId('issue-title')).toHaveText('Safari login returns 500')
  await expect(page.getByTestId('issue-state')).toContainText('In Progress')
  await expect(page.getByTestId('issue-priority')).toContainText('Urgent')
  await expect(page.getByTestId('issue-team')).toContainText('Engineering')
  await expect(page.getByTestId('issue-open-linear')).toHaveAttribute('href', /linear\.app\/.*ENG-201/)
  await expect(page.getByTestId('issue-description')).toContainText('Logging in on Safari fails with a 500')
  await expect(page.getByTestId('issue-description').locator('h2')).toHaveText('Problem')
  await expect(page.getByTestId('issue-description').locator('img')).toHaveCount(0) // remote images are not fetched
  await expect(page.getByTestId('issue-description')).toContainText('image not shown')
  const comments = page.getByTestId('issue-comment')
  await expect(comments).toHaveCount(2)
  await expect(comments.nth(0)).toContainText('Alice') // oldest first, newest last
  await expect(comments.nth(1)).toContainText('Bob')
  await shot(page, 'issue-detail-desktop')
  await page.reload()
  await expect(page.getByTestId('issue-title')).toHaveText('Safari login returns 500')
  await expect(page.getByTestId('issue-row').filter({ hasText: 'ENG-201' })).toHaveAttribute('aria-current', 'true')
  // Back / forward work.
  await page.getByTestId('issue-row').filter({ hasText: 'ENG-202' }).click()
  await expect(page.getByTestId('issue-title')).toHaveText('Add a dark mode toggle')
  await page.goBack()
  await expect(page.getByTestId('issue-title')).toHaveText('Safari login returns 500')
  await page.goForward()
  await expect(page.getByTestId('issue-title')).toHaveText('Add a dark mode toggle')
  await expect(detail).toHaveAttribute('data-ident', 'ENG-202')

  // A refresh asks Linear again; a failing Linear shows as an error and keeps the list.
  await page.waitForTimeout(5_500) // the server answers a refresh within 5 s of the last fetch from its cache
  lin.failList = true
  await page.getByTestId('issues-refresh').click()
  await expect(page.getByTestId('issues-error')).toBeVisible()
  await expect(page.getByTestId('issue-row')).toHaveCount(3)
  lin.failList = false
  await page.getByTestId('issues-refresh').click()
  await expect(page.getByTestId('issues-error')).toHaveCount(0)

  // Start a thread from ENG-202 (Todo): project auto-selected, session = "Let minbox choose" (the helper picks the agent).
  await page.getByTestId('issue-start-thread').click()
  const dlg = page.getByTestId('issue-thread-dialog')
  await expect(dlg).toBeVisible()
  await expect(page.getByTestId('issue-pick-note')).toBeVisible() // "Auto-selected: ..."
  await expect(page.getByTestId('issue-pick-picking')).toHaveCount(0)
  const sess = page.getByTestId('issue-thread-session')
  await expect(sess).toHaveValue('auto')
  await expect(sess.locator('option:checked')).toContainText('Let minbox choose')
  await expect(page.getByTestId('issue-thread-warning')).toContainText('minbox picks the agent')
  const preview = page.getByTestId('issue-thread-preview')
  await expect(preview).toContainText('<linear_issue_handoff')
  await expect(preview).toContainText('issue: ENG-202')
  await expect(preview).toContainText('A toggle in settings.')
  await page.getByTestId('issue-thread-instruction').fill('Please add the toggle, tests first')
  await expect(preview).toContainText('Please add the toggle, tests first')
  await shot(page, 'issue-start-thread-desktop')
  await page.getByTestId('issue-thread-start').click()
  // The agent's stream opens; the agent got the issue as untrusted context.
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await expectTerminal(page, 'linear_issue_handoff')
  await expectTerminal(page, 'Add a dark mode toggle')
  await expectTerminal(page, 'Please add the toggle, tests first')
  await expect.poll(() => lin.assigned.find((i: any) => i.identifier === 'ENG-202').status, { timeout: 15_000 }).toBe('In Progress')

  // Back on My issues the row shows the linked thread.
  await page.getByTestId('my-issues').click()
  await page.getByTestId('issue-row').filter({ hasText: 'ENG-202' }).click()
  await expect(page.getByTestId('issue-row').filter({ hasText: 'ENG-202' }).getByTestId('issue-row-threads')).toHaveText(/1/)
  await expect(page.getByTestId('issue-thread')).toHaveCount(1)
  await page.getByTestId('issue-thread').click()
  await expect(page.getByTestId('stream-view')).toBeVisible()

  // New issue from plain language. Linear's lists are held back until after ⌘/Ctrl+Enter, so the
  // request made while they load must be kept and sent once they arrive (not dropped).
  let releaseMeta!: () => void
  const metaHeld = new Promise<void>((r) => (releaseMeta = r))
  await page.route('**/api/linear/issues/draft', async (route) => {
    if (route.request().postDataJSON()?.stage === 'meta') await metaHeld
    await route.continue()
  })
  await page.getByTestId('my-issues').click()
  await page.getByTestId('issues-new').click()
  await expect(page.getByTestId('linear-create-plain')).toBeVisible()
  await expect(page.getByTestId('linear-create-loading')).toBeVisible()
  await expect(page.getByTestId('linear-create-generate')).toBeDisabled()
  await page.getByTestId('linear-create-plain').fill('Settings page crashes when the name is empty\nrepro: clear the name field and save')
  await page.getByTestId('linear-create-title').fill('My own title')
  await page.getByTestId('linear-create-plain').press('ControlOrMeta+Enter')
  await expect(page.getByTestId('linear-create-generate')).toHaveText('Drafting…')
  releaseMeta()
  await expect(page.getByTestId('linear-create-desc')).toHaveValue(/Drafted from the request/, { timeout: 15_000 })
  await page.unroute('**/api/linear/issues/draft')
  await expect(page.getByTestId('linear-create-title')).toHaveValue('My own title') // touched fields are never overwritten
  await expect(page.getByTestId('linear-create-team')).toHaveValue('team-1')
  await expect(page.getByTestId('linear-create-assignee')).toHaveValue('u1')
  await page.getByTestId('linear-create-title').fill('Settings crash on empty name')
  await shot(page, 'issue-new-desktop')
  await page.getByTestId('linear-create-submit').click()
  await expect(page.getByTestId('linear-create-plain')).toHaveCount(0)
  await expect(page).toHaveURL(/issue=ENG-101/)
  await expect(page.getByTestId('issue-title')).toHaveText('Settings crash on empty name')
  await expect(page.getByTestId('issue-row').filter({ hasText: 'ENG-101' })).toBeVisible()
  expect(lin.created).toHaveLength(1)
  expect(lin.created[0].args.assignee).toBe('u1')
  await expect(page.getByTestId('issue-start-thread')).toBeVisible()

  // Back to the threads from the rail.
  await page.getByTestId('project-all').click()
  await expect(page.getByTestId('issues-screen')).toHaveCount(0)
  await expect(page).not.toHaveURL(/v=issues/)
})

test('desktop: with several projects the helper picks one; "Let minbox choose" is the default session; changing the project re-defaults it', async ({ page, minbox }) => {
  test.setTimeout(150_000)
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  mkdirSync(join(minbox.dataDir, 'beta'))
  await createSession(page, join(minbox.dataDir, 'beta'), 'beta')
  await connect(page, minbox)
  await page.goto(`${minbox.url}/#v=issues&issue=ENG-202`)
  await expect(page.getByTestId('issue-title')).toHaveText('Add a dark mode toggle')
  await page.getByTestId('issue-start-thread').click()
  await expect(page.getByTestId('issue-pick-note')).toHaveAttribute('data-source', 'llm', { timeout: 15_000 })
  const proj = page.getByTestId('issue-thread-project')
  const sess = page.getByTestId('issue-thread-session')
  await expect(sess).toHaveValue('auto')
  // A session picked by hand; choosing the other project goes back to "Let minbox choose".
  const agent = await sess.locator('option').evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => o.value).find((v) => v !== 'auto' && v !== 'new'))
  await sess.selectOption(agent!)
  const other = await proj.locator('option').evaluateAll((os, cur) => (os as HTMLOptionElement[]).map((o) => o.value).find((v) => v !== cur), await proj.inputValue())
  await proj.selectOption(other!)
  await expect(sess).toHaveValue('auto')
  // New session stays selectable.
  await sess.selectOption('new')
  await expect(page.getByTestId('issue-thread-session-name')).toBeVisible()
  await expect(page.getByTestId('issue-thread-preview')).toContainText('linear_issue_handoff')
})

test('an unreadable list answer shows a Details block with a structure summary and a copy button, never the values', async ({ page, minbox, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const lin = minbox.linear
  lin.listRaw = [JSON.stringify({ issues: [{ summary: 'SecretSummaryText', n: 5 }, { summary: 'Other', n: 6 }] }), 'cursor note']
  await connect(page, minbox)
  await page.goto(`${minbox.url}/#v=issues`)
  await expect(page.getByTestId('issues-screen')).toBeVisible()
  await expect(page.getByTestId('issues-warning').first()).toContainText('2 items')
  const diag = page.getByTestId('issues-diagnostics')
  await expect(diag).toBeVisible()
  const text = page.getByTestId('issues-diagnostics-text')
  await expect(text).toContainText('tool: list_issues')
  await expect(text).toContainText('content blocks: 2 [text,text]')
  await expect(text).toContainText('item[0]: object{n:number, summary:string}')
  await expect(text).not.toContainText('SecretSummaryText')
  await page.getByTestId('issues-diagnostics-copy').click()
  await expect(page.getByTestId('issues-diagnostics-copy')).toHaveText('Copied')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('item[0]: object{n:number, summary:string}')
  // An odd but readable shape (text table in the second block) simply works.
  lin.listRaw = ['Your issues:', '| ID | Title | Status |\n|---|---|---|\n| ENG-9 | Nine | In Progress |']
  await page.waitForTimeout(5_500)
  await page.getByTestId('issues-refresh').click()
  await expect(page.getByTestId('issue-row')).toHaveCount(1)
  await expect(page.getByTestId('issues-diagnostics')).toHaveCount(0)
})

test('logged out: no entry, and the screen asks to connect', async ({ page, minbox }) => {
  await page.goto(`${minbox.url}/#v=issues`)
  await expect(page.getByTestId('issues-screen')).toBeVisible()
  await expect(page.getByTestId('issues-error')).toBeVisible()
  await expect(page.getByTestId('issues-connect')).toBeVisible()
  await expect(page.getByTestId('my-issues')).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('list, detail with back, start thread, new issue', async ({ page, minbox }) => {
    test.setTimeout(150_000)
    if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
    await startAgent(minbox, 'alpha')
    await connect(page, minbox)
    await page.goto(minbox.url)
    // The project sheet (the Agents tab's project button) has the entry.
    await page.getByTestId('tab-agents').tap()
    await page.getByTestId('project-switch').click()
    // The entry sits above All projects in the sheet.
    const a = (await page.getByTestId('my-issues').boundingBox())!
    const b = (await page.getByTestId('project-all').boundingBox())!
    expect(a.y).toBeLessThan(b.y)
    await page.getByTestId('my-issues').tap()
    await expect(page.getByTestId('issues-screen')).toHaveAttribute('data-screen', 'list')
    await expect(page.getByTestId('issue-row')).toHaveCount(3)
    await shot(page, 'issues-list-phone')
    await page.getByTestId('issue-row').filter({ hasText: 'ENG-201' }).tap()
    await expect(page.getByTestId('issues-screen')).toHaveAttribute('data-screen', 'detail')
    await expect(page.getByTestId('issue-title')).toHaveText('Safari login returns 500')
    await expect(page.getByTestId('issue-comment')).toHaveCount(2)
    await expect(page.getByTestId('issue-sticky-actions')).toBeVisible()
    await shot(page, 'issue-detail-phone')
    await page.getByTestId('issue-start-thread').tap()
    await expect(page.getByTestId('issue-thread-dialog')).toBeVisible()
    await expect(page.getByTestId('issue-pick-note')).toBeVisible()
    await shot(page, 'issue-start-thread-phone')
    await page.getByRole('button', { name: 'Cancel' }).tap()
    await page.getByTestId('issue-back').tap()
    await expect(page.getByTestId('issues-screen')).toHaveAttribute('data-screen', 'list')
    await page.getByTestId('issues-new').tap()
    await expect(page.getByTestId('linear-create-plain')).toBeVisible()
    await shot(page, 'issue-new-phone')
  })
})

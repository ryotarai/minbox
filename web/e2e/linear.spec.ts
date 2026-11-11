import { writeFileSync, rmSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal, type Minbox } from './fixtures'

// Linear integration, against a fake Linear (OAuth + MCP) on loopback: log in from Settings, link a
// thread to an issue, see its comments arrive when the thread opens, and have them delivered to
// the agent with the next message. No real Linear is ever contacted.

test('connect Linear, link an issue, receive its comments, deliver them to the agent', async ({ page, minbox }) => {
  const lin = minbox.linear

  // Settings › Integrations › Linear: Connect goes through the fake's authorize page and the
  // server's own callback, then lands back on Settings, connected.
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await expect(page.getByTestId('linear-status')).toHaveText('Not connected')
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })
  await expect(page.getByTestId('linear-test')).toBeVisible()
  await page.getByTestId('linear-test').click()
  await expect(page.getByTestId('linear-test-result')).toContainText('Works')

  // The comment filter defaults to everyone; switching to an allow-list shows its field.
  await expect(page.getByTestId('linear-filter-everyone')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('linear-filter-allow_list').click()
  await expect(page.getByTestId('linear-allowed')).toBeVisible()
  await page.getByTestId('linear-filter-everyone').click()
  await expect(page.getByTestId('linear-allowed')).toHaveCount(0)

  // A thread, linked by identifier.
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'lin')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Working on the login bug')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).first().click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Note')
  await page.getByTestId('linear-link-open').click()
  await page.getByTestId('linear-link-input').fill('nope')
  await page.getByTestId('linear-link-submit').click()
  await expect(page.getByTestId('linear-link-error')).toContainText('not a Linear issue')
  await page.getByTestId('linear-link-input').fill('ENG-123')
  await page.getByTestId('linear-link-submit').click()
  const chip = page.getByTestId('linear-chip')
  await expect(chip).toContainText('ENG-123')
  await expect(chip).toContainText('Fix the thing')
  await expect(page.getByTestId('linear-state')).toHaveText('Todo')

  // minbox keeps one progress comment on the issue (status only: the message stays private).
  await expect.poll(() => lin.comments.length).toBe(1)
  expect(lin.comments[0].body).toContain('minbox progress')
  expect(lin.comments[0].body).not.toContain('login bug')

  // New comments on the issue are fetched when the thread is opened, and shown as Linear items.
  lin.addComment('Alice', 'Please use approach B.')
  // (Opening syncs at most once in 45 s per thread, and linking just did; the Sync link forces it.)
  await page.reload()
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).first().click()
  await page.getByTestId('linear-sync').click()
  const ev = page.getByTestId('linear-event')
  await expect(ev).toContainText('Please use approach B.', { timeout: 15_000 })
  await expect(ev).toContainText('Alice')
  await expect(ev).toContainText('Linear')

  // They reach the agent in front of the next message, delimited and marked as external.
  const threads: { id: string; subject: string }[] = await (await fetch(minbox.url + '/api/threads')).json()
  const id = threads.find((t) => t.subject === 'Note')!.id
  const r = await fetch(`${minbox.url}/api/threads/${id}/reply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words: 'go ahead' }) })
  expect(r.ok).toBeTruthy()
  await expectTerminal(page, 'Please use approach B.')
  await expectTerminal(page, 'linear_updates source="untrusted"')

  // Work starts: the issue moves to In Progress.
  await fetch(`${minbox.url}/api/threads/${id}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'working' }) })
  await expect.poll(() => lin.issue.state.name).toBe('In Progress')

  // Unlink.
  await page.getByTestId('linear-unlink').click()
  await expect(page.getByTestId('linear-chip')).toHaveCount(0)
  await expect(page.getByTestId('linear-link-open')).toBeVisible()
})

// Create Linear issue from a thread: the dialog opens at once with Linear's lists and a basic
// prefill, the helper agent's guess arrives late and fills only what the person has not touched,
// Create makes the issue (once, even on a double click) and links the thread.
test('create a Linear issue from a thread: late draft keeps what was typed; create links the thread', async ({ page, minbox }) => {
  const lin = minbox.linear
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await expect(page.getByTestId('linear-status')).toHaveText('Not connected')
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })

  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'lin-create')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Working on the login bug')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).first().click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Note')

  // The helper's guess is held back until we let it go.
  writeFileSync(minbox.draftHold, '')
  await page.getByTestId('linear-create-open').click()
  const submit = page.getByTestId('linear-create-submit')
  await expect(page.getByTestId('linear-create-drafting')).toBeVisible()
  // Linear's lists and the certain defaults are there while the draft is pending; the title and
  // description are empty with a "Drafting…" hint (no flash of the basic prefill).
  await expect(page.getByTestId('linear-create-team').locator('option')).toHaveCount(3) // placeholder + 2 teams
  await expect(page.getByTestId('linear-create-assignee')).toHaveValue('u1')
  await expect(page.getByTestId('linear-create-title')).toHaveValue('')
  await expect(page.getByTestId('linear-create-title')).toHaveAttribute('placeholder', 'Drafting…')
  await expect(page.getByTestId('linear-create-desc')).toHaveValue('')
  await expect(page.getByTestId('linear-create-desc')).toHaveAttribute('placeholder', 'Drafting…')
  // Team is required: no team, no Create.
  await expect(submit).toBeDisabled()
  // Typing meanwhile.
  await page.getByTestId('linear-create-title').fill('My own title')
  await page.getByTestId('linear-create-priority').selectOption('4')

  rmSync(minbox.draftHold)
  await expect(page.getByTestId('linear-create-drafting')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('linear-create-desc')).not.toHaveAttribute('placeholder', 'Drafting…')
  // Untouched fields were filled by the guess; the touched ones were not overwritten.
  await expect(page.getByTestId('linear-create-team')).toHaveValue('team-1')
  await expect(page.getByTestId('linear-create-desc')).toHaveValue(/Drafted from the thread/)
  await expect(page.getByTestId('linear-create-project')).toHaveValue('proj-1')
  await expect(page.getByTestId('linear-create-state')).toHaveValue('st-3')
  await expect(page.getByTestId('linear-create-label-Bug')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('linear-create-title')).toHaveValue('My own title')
  await expect(page.getByTestId('linear-create-priority')).toHaveValue('4')
  expect(lin.created.length).toBe(0) // nothing written to Linear yet

  // Required title.
  await page.getByTestId('linear-create-title').fill('')
  await expect(submit).toBeDisabled()
  await page.getByTestId('linear-create-title').fill('My own title')
  await expect(submit).toBeEnabled()

  await submit.dblclick()
  const chip = page.getByTestId('linear-chip')
  await expect(chip).toContainText('ENG-101')
  await expect(chip).toContainText('My own title')
  await expect(page.getByTestId('linear-create-submit')).toHaveCount(0)
  expect(lin.created.length).toBe(1)
  const a = lin.created[0].args
  expect(a.team).toBe('team-1')
  expect(a.title).toBe('My own title')
  expect(a.priority).toBe(4)
  expect(a.labels).toEqual(['lab-1'])
  expect(a.project).toBe('proj-1')
  expect(a.assignee).toBe('u1')
  expect(a.state).toBe('st-3')
  expect(a.description).toContain('Drafted from the thread')
  // Linked like a pasted issue: no second create offered, unlink available.
  await expect(page.getByTestId('linear-create-open')).toHaveCount(0)
  await expect(page.getByTestId('linear-unlink')).toBeVisible()
})

async function openCreateDialog(page: Page, minbox: Minbox, name: string) {
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('linear-connect').click()
  await expect(page.getByTestId('linear-status')).toHaveText('Connected', { timeout: 15_000 })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, name)
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Working on the login bug')
  await page.getByTestId('thread-row').filter({ hasText: 'Note' }).first().click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Note')
  await page.getByTestId('linear-create-open').click()
}

test('Linear create dialog: when the helper fails, the basic draft is applied afterwards with a note', async ({ page, minbox }) => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  await page.route('**/api/threads/*/linear/draft', async (route) => {
    if (route.request().postDataJSON()?.stage !== 'llm') return route.continue()
    await gate
    await route.fulfill({ json: { reason: 'error', note: 'Could not draft with the helper agent (boom): a basic draft is shown.' } })
  })
  await openCreateDialog(page, minbox, 'lin-fail')
  await expect(page.getByTestId('linear-create-team').locator('option')).toHaveCount(3)
  await expect(page.getByTestId('linear-create-title')).toHaveValue('')
  await expect(page.getByTestId('linear-create-desc')).toHaveValue('')
  release()
  await expect(page.getByTestId('linear-create-note')).toContainText('boom')
  await expect(page.getByTestId('linear-create-title')).toHaveValue('Note')
  await expect(page.getByTestId('linear-create-desc')).not.toHaveValue('')
  await expect(page.getByTestId('linear-create-drafting')).toHaveCount(0)
})

test('Linear create dialog: without a helper agent the basic draft is there at once', async ({ page, minbox }) => {
  let llmCalls = 0
  await page.route('**/api/threads/*/linear/draft', async (route) => {
    if (route.request().postDataJSON()?.stage === 'llm') llmCalls++
    if (route.request().postDataJSON()?.stage !== 'meta') return route.continue()
    const r = await route.fetch()
    const j = await r.json()
    await route.fulfill({ response: r, json: { ...j, llm_available: false, llm_reason: 'no_agent' } })
  })
  await openCreateDialog(page, minbox, 'lin-nohelper')
  await expect(page.getByTestId('linear-create-title')).toHaveValue('Note')
  await expect(page.getByTestId('linear-create-desc')).not.toHaveValue('')
  await expect(page.getByTestId('linear-create-title')).not.toHaveAttribute('placeholder', 'Drafting…')
  await expect(page.getByTestId('linear-create-drafting')).toHaveCount(0)
  expect(llmCalls).toBe(0)
})

// The lists that hang on a team (workflow states, labels) are fetched only for a team that gets
// selected: nothing per team while the dialog loads, one pair of calls per selected team, a loading
// indicator meanwhile, the old team's choices cleared on a switch, a cache hit when going back.
test("Linear create dialog: a team's states and labels load when it is selected, and only then", async ({ page, minbox }) => {
  const lin = minbox.linear
  const teamsOf = (tool: string) => lin.calls.filter((c) => c.tool === tool).map((c) => c.args.team)
  writeFileSync(minbox.draftHold, '')
  await openCreateDialog(page, minbox, 'lin-lazy')
  await expect(page.getByTestId('linear-create-team').locator('option')).toHaveCount(3)
  await expect(page.getByTestId('linear-create-drafting')).toBeVisible()
  // The draft is pending and no team is chosen: Linear was asked for no team's lists.
  expect(teamsOf('list_issue_statuses')).toEqual([])
  expect(teamsOf('list_issue_labels')).toEqual([])
  rmSync(minbox.draftHold)
  await expect(page.getByTestId('linear-create-drafting')).toHaveCount(0, { timeout: 15_000 })
  // The draft chose team 1: its lists (one pair of calls) came with it.
  await expect(page.getByTestId('linear-create-team')).toHaveValue('team-1')
  await expect(page.getByTestId('linear-create-label-Bug')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('linear-create-state')).toHaveValue('st-3')
  expect(teamsOf('list_issue_statuses')).toEqual(['team-1'])
  expect(teamsOf('list_issue_labels')).toEqual(['team-1'])

  // Switch to team 2: loading indicator, fields held back, then its own lists; the old choices are gone.
  lin.statusesDelay = 1500
  await page.getByTestId('linear-create-title').fill('Mine')
  await page.getByTestId('linear-create-team').selectOption('team-2')
  await expect(page.getByTestId('linear-create-team-loading')).toHaveText('Loading states and labels…')
  await expect(page.getByTestId('linear-create-state')).toBeDisabled()
  await expect(page.getByTestId('linear-create-label-Bug')).toHaveCount(0)
  await expect(page.getByTestId('linear-create-team-loading')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('linear-create-label-Pixels')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('linear-create-state')).toBeEnabled()
  await expect(page.getByTestId('linear-create-state')).toHaveValue('st-d1') // the team's default
  await expect(page.getByTestId('linear-create-state').locator('option')).toHaveText(['Team default', 'Backlog', 'In Review'])
  await expect(page.getByTestId('linear-create-title')).toHaveValue('Mine') // typed text kept
  // Both teams' lists are in the Details, with the team named.
  await expect(page.getByTestId('linear-create-lists-summary')).toContainText('list_issue_statuses of Design')
  expect(teamsOf('list_issue_statuses')).toEqual(['team-1', 'team-2'])
  expect(teamsOf('list_issue_labels')).toEqual(['team-1', 'team-2'])

  // Back to team 1: cached, no new calls, and team 2's choices do not carry over.
  lin.statusesDelay = 0
  await page.getByTestId('linear-create-team').selectOption('team-1')
  await expect(page.getByTestId('linear-create-label-Bug')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('linear-create-state')).toHaveValue('st-2')
  expect(teamsOf('list_issue_statuses')).toEqual(['team-1', 'team-2'])
})

test("Linear create dialog: a team already selected when the draft starts is the draft's team (one step, no lists for other teams)", async ({ page, minbox }) => {
  const lin = minbox.linear
  // The basic prefill names team 2 (as when a team is named like the minbox project): it is selected
  // before the draft request is made, which then asks for a draft for that team.
  let llmBody: any
  await page.route('**/api/threads/*/linear/draft', async (route) => {
    const body = route.request().postDataJSON()
    if (body?.stage === 'llm') {
      llmBody = body
      return route.continue()
    }
    const r = await route.fetch()
    const j = await r.json()
    await route.fulfill({ response: r, json: { ...j, fallback: { ...j.fallback, team_id: 'team-2' } } })
  })
  await openCreateDialog(page, minbox, 'lin-preteam')
  await expect(page.getByTestId('linear-create-drafting')).toHaveCount(0, { timeout: 15_000 })
  await expect(page.getByTestId('linear-create-team')).toHaveValue('team-2')
  expect(llmBody.team_id).toBe('team-2')
  await expect(page.getByTestId('linear-create-state')).toHaveValue('st-d2')
  await expect(page.getByTestId('linear-create-label-Pixels')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('linear-create-desc')).toHaveValue(/Drafted from the thread/)
  // Team 1 was never asked for; team 2 once.
  const lists = lin.calls.filter((c) => c.tool === 'list_issue_statuses' || c.tool === 'list_issue_labels')
  expect(lists.map((c) => c.args.team)).toEqual(['team-2', 'team-2'])
})

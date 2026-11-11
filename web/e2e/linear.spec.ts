import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

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

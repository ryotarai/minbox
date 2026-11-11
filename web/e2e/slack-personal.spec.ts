import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, type Minbox } from './fixtures'
import { FAKE_USER_TOKEN } from './fake-slack-user'

// Slack (personal): the user token in Settings, the Slack screen (threads that need my reply,
// judged by the helper), dismiss / snooze, and starting a minbox thread. Against the fake Slack
// (user-token methods) and the fake helper, both on loopback; no real Slack is contacted.

const SHOTS = process.env.SLACK_SHOTS // a folder: dark-theme screenshots for review

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') })
}

async function connect(page: Page, minbox: Minbox) {
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await expect(page.getByTestId('slack-status')).toHaveText('Not connected')
  await page.getByTestId('slack-token').fill(FAKE_USER_TOKEN)
  await page.getByTestId('slack-connect').click()
  await expect(page.getByTestId('slack-status')).toHaveText('Connected')
}

test('settings: connect with errors, scopes, manifest, backend, details, disconnect; the rail entry shows only when connected', async ({ page, minbox }) => {
  test.setTimeout(90_000)
  if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
  const sl = minbox.slackUser
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await expect(page.getByTestId('slack-status')).toHaveText('Not connected')
  await expect(page.getByTestId('slack-privacy')).toContainText('never sent to the browser or to coding agents')
  // A wrong token is refused with a plain explanation and nothing is stored.
  await page.getByTestId('slack-token').fill(['xoxp', '9999999999', 'wrongwrongwrongwrong'].join('-'))
  await page.getByTestId('slack-connect').click()
  await expect(page.getByTestId('slack-test-message')).toContainText('copy the User OAuth Token')
  await expect(page.getByTestId('slack-status')).toHaveText('Not connected')
  // A bot token is refused before any call.
  const calls = sl.calls.length
  await page.getByTestId('slack-token').fill(['xoxb', '1234567890', 'abcdefghijkl'].join('-'))
  await page.getByTestId('slack-connect').click()
  await expect(page.getByTestId('slack-test-message')).toContainText('bot token')
  expect(sl.calls.length).toBe(calls)
  // A good token.
  await page.getByTestId('slack-token').fill(FAKE_USER_TOKEN)
  await page.getByTestId('slack-connect').click()
  await expect(page.getByTestId('slack-status')).toHaveText('Connected')
  await expect(page.getByTestId('slack-conn')).toContainText('Connected as ryota in Acme')
  await expect(page.getByTestId('slack-test-message')).toContainText('Connected as ryota in Acme')
  await expect(page.getByTestId('slack-test-search')).toContainText('Real-time Search (assistant.search.context) search works')
  // The token is masked everywhere on the page.
  await expect(page.getByTestId('slack-token')).toHaveValue('')
  expect(await page.locator('body').innerText()).not.toContain(FAKE_USER_TOKEN)
  await expect(page.getByTestId('slack-conn')).toContainText('xoxp-…')
  await expect(page.getByTestId('slack-missing')).toHaveCount(0)
  // Test names a missing scope.
  sl.scopes = 'search:read.public,channels:history,users:read'
  await page.getByTestId('slack-test').click()
  await expect(page.getByTestId('slack-missing')).toContainText('im:history')
  await expect(page.getByTestId('slack-missing')).toContainText('groups:history')
  sl.scopes = 'search:read.public,search:read.private,search:read.im,channels:history,groups:history,im:history,users:read,im:read'
  await page.getByTestId('slack-test').click()
  await expect(page.getByTestId('slack-missing')).toHaveCount(0)
  // Auto falls back to the legacy search when the Real-time Search API refuses (and says so).
  sl.rtsError = 'unknown_method'
  await page.getByTestId('slack-test').click()
  await expect(page.getByTestId('slack-test-search')).toContainText('Falling back to the legacy search.messages')
  sl.rtsError = ''
  // The search backend setting.
  await page.getByTestId('slack-backend').selectOption('legacy')
  await expect(page.getByTestId('slack-backend')).toHaveValue('legacy')
  await page.getByTestId('slack-backend').selectOption('auto')
  // Setup help: the manifest, both flavours.
  await page.getByTestId('slack-setup').locator('summary').click()
  await expect(page.getByTestId('slack-manifest')).toContainText('search:read.public')
  await expect(page.getByTestId('slack-manifest')).toContainText('token_rotation_enabled: false')
  await expect(page.getByTestId('slack-manifest')).not.toContainText('chat:write')
  await page.getByTestId('slack-manifest-flavor').selectOption('legacy')
  await expect(page.getByTestId('slack-manifest')).toContainText('- search:read\n')
  await expect(page.getByTestId('slack-manifest')).not.toContainText('search:read.public')
  // Details.
  await page.getByTestId('slack-details').locator('summary').click()
  await expect(page.getByTestId('slack-details-calls')).toContainText('auth.test')
  await expect(page.getByTestId('slack-details-ratelimit')).toContainText('not limited')
  await expect(page.getByTestId('slack-unverified')).toContainText('Real-time Search')
  await shot(page, 'slack-settings-desktop')

  // The entry shows above All projects (and not My issues: Linear is not connected).
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  const entry = page.getByTestId('slack-entry')
  await expect(entry).toBeVisible()
  await expect(page.getByTestId('my-issues')).toHaveCount(0)
  const a = (await entry.boundingBox())!
  const b = (await page.getByTestId('project-all').boundingBox())!
  expect(a.y).toBeLessThan(b.y)
  // Disconnect removes it and the stored data.
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('slack-disconnect').click()
  await expect(page.getByTestId('slack-status')).toHaveText('Not connected')
  await page.goto(minbox.url)
  await expect(page.getByTestId('project-all')).toBeVisible()
  await expect(page.getByTestId('slack-entry')).toHaveCount(0)
  await page.goto(`${minbox.url}/#v=slack`)
  await expect(page.getByTestId('slack-error')).toContainText('Slack is not connected')
})

test('desktop: list groups, detail, dismiss / snooze, cache, start a minbox thread', async ({ page, minbox }) => {
  test.setTimeout(150_000)
  if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
  const sl = minbox.slackUser
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  mkdirSync(join(minbox.dataDir, 'eng'))
  await page.getByTestId('new-session').click()
  await createSession(page, join(minbox.dataDir, 'eng'), 'eng')
  await connect(page, minbox)
  await page.goto(minbox.url)
  await page.getByTestId('slack-entry').click()
  await expect(page).toHaveURL(/v=slack/)
  await expect(page.getByTestId('slack-screen')).toBeVisible()

  // Groups: one needs a reply (high), the DM is a maybe with an unread dot; the thanks-only and the "I wrote last" threads are not listed.
  const needs = page.locator('[data-testid="slack-group"][data-group="needs_reply"]')
  const maybe = page.locator('[data-testid="slack-group"][data-group="maybe"]')
  await expect(needs.getByTestId('slack-row')).toHaveCount(1)
  await expect(maybe.getByTestId('slack-row')).toHaveCount(1)
  await expect(page.getByTestId('slack-count-needs')).toHaveText('1 need a reply')
  await expect(page.getByTestId('slack-count-maybe')).toHaveText('1 maybe')
  await expect(page.getByTestId('slack-hidden')).toContainText('2 more threads')
  const row = needs.getByTestId('slack-row')
  await expect(row.getByTestId('slack-row-label')).toContainText('#eng')
  await expect(row.getByTestId('slack-row-snippet')).toContainText('Alice:')
  await expect(row.getByTestId('slack-row-snippet')).toContainText('any news?')
  await expect(row.getByTestId('slack-row-reason')).toContainText('review PR 12 before noon')
  await expect(row.getByTestId('slack-urgency')).toHaveAttribute('data-urgency', 'high')
  const dm = maybe.getByTestId('slack-row')
  await expect(dm.getByTestId('slack-row-label')).toContainText('DM with Alice')
  await expect(dm.getByTestId('slack-unread')).toBeVisible()
  await shot(page, 'slack-list-desktop')
  // Client-side search.
  await page.getByTestId('slack-search').fill('quick call')
  await expect(page.getByTestId('slack-row')).toHaveCount(1)
  await page.getByTestId('slack-search').fill('nothing like this')
  await expect(page.getByTestId('slack-none')).toBeVisible()
  await page.getByTestId('slack-search').fill('')
  await expect(page.getByTestId('slack-row')).toHaveCount(2)

  // Detail: messages with safe mrkdwn, the judgement, the permalink. The selection is in the URL.
  await row.click()
  await expect(page).toHaveURL(/thread=C1(:|%3A)/)
  const detail = page.getByTestId('slack-detail')
  const msgs = page.getByTestId('slack-message')
  await expect(msgs).toHaveCount(2)
  await expect(msgs.nth(0).getByTestId('slack-message-author')).toHaveText('Alice')
  const body = msgs.nth(0).getByTestId('slack-message-body')
  await expect(body.locator('b')).toHaveText('PR 12')
  await expect(body.locator('code')).toHaveText('auth')
  await expect(body.locator('.mention').first()).toHaveText('@Ryota')
  await expect(body.locator('blockquote')).toContainText('small change, but risky')
  await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/pr/12')
  await expect(msgs.nth(0).getByTestId('slack-message-files')).toContainText('diff.patch')
  await expect(page.getByTestId('slack-judgement-reason')).toContainText('review PR 12 before noon')
  await expect(page.getByTestId('slack-judgement-summary')).toContainText('auth flow')
  await expect(page.getByTestId('slack-judgement')).toContainText('machine-generated')
  await expect(page.getByTestId('slack-open')).toHaveAttribute('href', /^https:\/\/acme\.slack\.test\/archives\/C1\/p/)
  await shot(page, 'slack-detail-desktop')
  await page.reload()
  await expect(page.getByTestId('slack-message')).toHaveCount(2)
  await expect(page.getByTestId('slack-row').first()).toHaveAttribute('aria-current', 'true')
  await maybe.getByTestId('slack-row').click()
  await expect(detail).toHaveAttribute('data-id', 'D1:dm')
  await page.goBack()
  await expect(detail).toHaveAttribute('data-id', /^C1:/)
  await page.goForward()
  await expect(detail).toHaveAttribute('data-id', 'D1:dm')

  // Dismiss moves it to the collapsed group; restoring brings it back.
  await row.click()
  await page.getByTestId('slack-dismiss').click()
  await expect(needs.getByTestId('slack-row')).toHaveCount(0)
  await expect(page.getByTestId('slack-dismissed-toggle')).toContainText('1')
  await expect(page.locator('[data-testid="slack-row"][data-group="dismissed"]')).toHaveCount(0) // collapsed
  await page.getByTestId('slack-dismissed-toggle').click()
  await expect(page.locator('[data-testid="slack-row"][data-group="dismissed"]')).toHaveCount(1)
  await shot(page, 'slack-dismissed-desktop')
  await page.getByTestId('slack-restore').click()
  await expect(needs.getByTestId('slack-row')).toHaveCount(1)
  // Snooze for an hour: hidden with the group of dismissed items, with its end time.
  await page.getByTestId('slack-snooze').click()
  await page.getByTestId('slack-snooze-1h').click()
  await expect(needs.getByTestId('slack-row')).toHaveCount(0)
  await expect(page.locator('[data-testid="slack-row"][data-group="dismissed"]').getByTestId('slack-row-reason')).toContainText('until')
  await page.getByTestId('slack-restore').click()
  await expect(needs.getByTestId('slack-row')).toHaveCount(1)

  // A refresh asks Slack's search again, but reads and judges nothing that has not changed.
  const replies = sl.count('conversations.replies')
  const searches = sl.count('assistant.search.context')
  await page.getByTestId('slack-refresh').click()
  await expect.poll(() => sl.count('assistant.search.context')).toBeGreaterThan(searches)
  await expect(page.getByTestId('slack-syncing')).toHaveCount(0)
  expect(sl.count('conversations.replies')).toBe(replies)

  // Start a minbox thread: project auto-selected (named like the channel), the project's main session is the default.
  await row.click()
  await page.getByTestId('slack-start-thread').click()
  await expect(page.getByTestId('slack-thread-dialog')).toBeVisible()
  await expect(page.getByTestId('slack-pick-note')).toHaveAttribute('data-source', 'name')
  await expect(page.getByTestId('slack-pick-picking')).toHaveCount(0)
  const sess = page.getByTestId('slack-thread-session')
  await expect(sess.locator('option:checked')).toContainText('Main session')
  const preview = page.getByTestId('slack-thread-preview')
  await expect(preview).toContainText('<slack_thread_handoff')
  await expect(preview).toContainText('channel: #eng')
  await expect(preview).toContainText('can you review')
  await expect(preview).toContainText('machine_summary')
  await page.getByTestId('slack-thread-instruction').fill('Draft my reply to Alice')
  await expect(preview).toContainText('Draft my reply to Alice')
  await shot(page, 'slack-start-thread-desktop')
  await page.getByTestId('slack-thread-start').click()
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-thread-id', /^thr_/)
  await expectTerminal(page, 'slack_thread_handoff')
  await expectTerminal(page, 'Draft my reply to Alice')
  // The Slack list shows the link, and the detail opens the minbox thread.
  await page.getByTestId('slack-entry').click()
  await expect(page.getByTestId('slack-row').filter({ hasText: '#eng' }).getByTestId('slack-row-thread')).toBeVisible()
  await page.getByTestId('slack-row').filter({ hasText: '#eng' }).click()
  await expect(page.getByTestId('slack-linked-thread')).toBeVisible()
  await page.getByTestId('slack-linked-thread').click()
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-thread-id', /^thr_/)
  // Back to the threads from the rail.
  await page.getByTestId('slack-entry').click()
  await page.getByTestId('project-all').click()
  await expect(page.getByTestId('slack-screen')).toHaveCount(0)
})

test('the helper failing leaves threads unjudged under Maybe, judged again on the next refresh', async ({ page, minbox }) => {
  test.setTimeout(90_000)
  writeFileSync(join(minbox.dataDir, 'judge.fail'), '')
  await connect(page, minbox)
  await page.goto(`${minbox.url}/#v=slack`)
  // The review request, the DM and the thanks-only thread were all read; none could be judged.
  await expect(page.getByTestId('slack-row')).toHaveCount(3, { timeout: 20_000 })
  await expect(page.locator('[data-testid="slack-group"][data-group="maybe"]').getByTestId('slack-row')).toHaveCount(3)
  await expect(page.getByTestId('slack-row-reason').first()).toContainText('Not judged yet')
  await expect(page.getByTestId('slack-note').filter({ hasText: 'could not judge' })).toBeVisible()
  await page.getByTestId('slack-row').first().click()
  await expect(page.getByTestId('slack-unjudged')).toBeVisible()
  // The helper is back: the next refresh judges them (the threads are not read again).
  rmSync(join(minbox.dataDir, 'judge.fail'))
  const replies = minbox.slackUser.count('conversations.replies')
  await page.getByTestId('slack-refresh').click()
  await expect(page.locator('[data-testid="slack-group"][data-group="needs_reply"]').getByTestId('slack-row')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByTestId('slack-row')).toHaveCount(2)
  expect(minbox.slackUser.count('conversations.replies')).toBe(replies)
})

test('a rate limit shows partial results and waits; the Real-time Search API refused falls back to the legacy search', async ({ page, minbox }) => {
  test.setTimeout(90_000)
  const sl = minbox.slackUser
  sl.rtsError = 'unknown_method'
  sl.repliesLimit = 25
  await connect(page, minbox)
  await page.goto(`${minbox.url}/#v=slack`)
  // The DM (read by history) is listed; the thread reads stopped at the first 429.
  await expect(page.getByTestId('slack-partial')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('slack-row')).toHaveCount(1)
  await expect(page.getByTestId('slack-note').filter({ hasText: 'slow down' })).toBeVisible()
  await expect(page.getByTestId('slack-backend-note')).toContainText('legacy search.messages')
  expect(sl.count('search.messages')).toBeGreaterThan(0)
  expect(sl.count('conversations.replies')).toBe(1)
  // Pressing Refresh during the wait does not call Slack's rate-limited method again.
  await page.getByTestId('slack-refresh').click()
  await expect(page.getByTestId('slack-syncing')).toHaveCount(0)
  expect(sl.count('conversations.replies')).toBe(1)
  // Settings > Details show it.
  await page.goto(`${minbox.url}/#v=settings&ss=integrations`)
  await page.getByTestId('slack-details').locator('summary').click()
  await expect(page.getByTestId('slack-details-ratelimit')).toContainText('waiting until')
  await expect(page.getByTestId('slack-details-backend')).toContainText('legacy')
  // After the wait, with Slack willing again, the rest is read.
  sl.repliesLimit = 0
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('list, detail with back, start thread', async ({ page, minbox }) => {
    test.setTimeout(150_000)
    if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'alpha')
    await expectTerminal(page, 'ready>')
    await connect(page, minbox)
    await page.goto(minbox.url)
    await page.getByTestId('project-switch').click()
    const a = (await page.getByTestId('slack-entry').boundingBox())!
    const b = (await page.getByTestId('project-all').boundingBox())!
    expect(a.y).toBeLessThan(b.y)
    await page.getByTestId('slack-entry').tap()
    await expect(page.getByTestId('slack-screen')).toHaveAttribute('data-screen', 'list')
    await expect(page.getByTestId('slack-row')).toHaveCount(2)
    await shot(page, 'slack-list-phone')
    await page.getByTestId('slack-row').first().tap()
    await expect(page.getByTestId('slack-screen')).toHaveAttribute('data-screen', 'detail')
    await expect(page.getByTestId('slack-message')).toHaveCount(2)
    await expect(page.getByTestId('slack-sticky-actions')).toBeVisible()
    await shot(page, 'slack-detail-phone')
    await page.getByTestId('slack-start-thread').tap()
    await expect(page.getByTestId('slack-thread-dialog')).toBeVisible()
    await expect(page.getByTestId('slack-pick-note')).toBeVisible()
    await shot(page, 'slack-start-thread-phone')
    await page.getByRole('button', { name: 'Cancel' }).tap()
    await page.getByTestId('slack-detail-back').tap()
    await expect(page.getByTestId('slack-screen')).toHaveAttribute('data-screen', 'list')
  })
})

import type { Page } from '@playwright/test'
import { chooseFolder, createSession, expect, expectTerminal, phoneSelectSession, selectSession, test, typeInTerminal } from './fixtures'

// UI v2: the thread is the first-class object. One list of every session's threads on the left, the
// open thread beside it, and the thread's session (terminal) on the right.

/** alpha waits on the person (a question), beta has an unread note, gamma has a note too. */
async function seed(page: Page, dir: string) {
  await createSession(page, dir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await createSession(page, dir, 'beta')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Beta note')
  await expectTerminal(page, /sent .*thr_/)
  await createSession(page, dir, 'gamma')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Gamma note')
  await expectTerminal(page, /sent .*thr_/)
  await expect(page.getByTestId('thread-row')).toHaveCount(3)
}

const row = (page: Page, text: string) => page.getByTestId('thread-list').getByTestId('thread-row').filter({ hasText: text })

for (const width of [1500, 1920]) {
  test(`desktop ${width}px: threads | thread | terminal, nothing overflows`, async ({ page, minbox }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(minbox.url)
    await seed(page, minbox.dataDir)
    await row(page, 'Pick a database').click()
    await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
    const m = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
      return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, list: r('[data-testid="threads-pane"]'), thread: r('[data-testid="thread-pane"]'), main: r('main') }
    })
    expect(m.scroll).toBeLessThanOrEqual(m.inner)
    expect(m.list.right).toBeLessThanOrEqual(m.thread.left + 1)
    expect(m.thread.right).toBeLessThanOrEqual(m.main.left + 1)
    expect(m.main.right).toBeLessThanOrEqual(m.inner + 0.5)
    expect(m.list.width).toBeGreaterThanOrEqual(279) // the 280 px column less its 1 px right border
    expect(m.thread.width).toBeGreaterThanOrEqual(380)
    expect(m.main.width).toBeGreaterThanOrEqual(width >= 1680 ? 600 : 400)
    // With the shell pane open nothing overflows either.
    await page.getByTestId('shell-toggle').click()
    await expect(page.getByTestId('shell-pane')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}

test('a thread of another session switches the thread view and the terminal; the same session keeps the terminal', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  // Two threads in alpha, so there is something to move between within one session.
  await selectSession(page, 'alpha')
  await page.getByTestId('quick-body').fill('Second alpha idea')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Second alpha idea')
  await page.getByTestId('session-filter').click()
  await page.getByTestId('session-all').click()
  await expect(page.getByTestId('thread-row')).toHaveCount(4)

  await row(page, 'Beta note').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  await expect(page.getByTestId('thread-subject')).toHaveText('Note')
  await expectTerminal(page, 'ready>')

  // Mark the terminal element; moving between alpha's threads must not replace it.
  await row(page, 'Pick a database').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await page.getByTestId('terminal').evaluate((el) => el.setAttribute('data-mark', 'same'))
  await row(page, 'Second alpha idea').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Second alpha idea')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('terminal')).toHaveAttribute('data-mark', 'same')
  // Another session's thread replaces it.
  await row(page, 'Gamma note').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('gamma')
  await expect(page.getByTestId('terminal')).not.toHaveAttribute('data-mark', 'same')
  // The URL carries both.
  await expect.poll(() => page.url()).toMatch(/#s=.*&t=/)
})

test('the session chip of a row opens that session without a thread', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await row(page, 'Pick a database').click()
  await expect(page.getByTestId('thread-subject')).toBeVisible()
  await row(page, 'Beta note').getByTestId('thread-session').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  await expect(page.getByTestId('thread-empty')).toBeVisible()
  await expect(page.getByTestId('recent-session')).toHaveCount(0)
})

test('composer: the target is the current session, can be switched, and a new thread starts there', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  const target = page.getByTestId('composer-target-name')
  // gamma was the last session made and is selected.
  await expect(target).toHaveText('gamma')
  await row(page, 'Pick a database').click()
  await expect(target).toHaveText('alpha') // follows the open thread

  // Draft is kept per target: a pick holds while this session stays selected.
  await page.getByTestId('quick-body').fill('for alpha')
  await page.getByTestId('composer-target').click()
  await expect(page.getByTestId('session-option')).toHaveCount(3)
  await page.getByTestId('session-picker-search').fill('bet')
  await expect(page.getByTestId('session-option')).toHaveCount(1)
  await page.getByTestId('session-option').click()
  await expect(target).toHaveText('beta')
  await expect(page.getByTestId('quick-body')).toHaveValue('')
  await page.getByTestId('quick-body').fill('hello beta')
  await page.getByTestId('composer-target').click()
  await page.getByTestId('session-option').filter({ hasText: 'alpha' }).click()
  await expect(page.getByTestId('quick-body')).toHaveValue('for alpha')
  await page.getByTestId('composer-target').click()
  await page.getByTestId('session-option').filter({ hasText: 'beta' }).click()
  await expect(page.getByTestId('quick-body')).toHaveValue('hello beta')

  // Sending starts a new thread in beta and opens it, with beta's terminal.
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('hello beta')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  await expect(row(page, 'hello beta').getByTestId('thread-session')).toHaveText('beta')
  await expectTerminal(page, '<<< inbox [hello beta]')
})

test('composer: + New session… creates a session and sends the typed message into it', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'first')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('quick-body').fill('Start the migration')
  await page.getByTestId('composer-target').click()
  await page.getByTestId('composer-new-session').click()
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible()
  await chooseFolder(page)
  await page.getByTestId('new-session-cwd').fill(minbox.dataDir)
  await page.getByTestId('new-session-name').fill('fresh')
  await page.getByTestId('new-session-start').click()

  await expect(page.getByTestId('terminal-session-name')).toHaveText('fresh')
  await expect(page.getByTestId('composer-target-name')).toHaveText('fresh')
  await expect(page.getByTestId('thread-subject')).toHaveText('Start the migration')
  await expect(row(page, 'Start the migration').getByTestId('thread-session')).toHaveText('fresh')
  await expectTerminal(page, '<<< inbox [Start the migration]')
  // The first session's box did not keep the text.
  await selectSession(page, 'first')
  await expect(page.getByTestId('quick-body')).toHaveValue('')
})

test('filters: Waiting, Unread, a session, and grouping', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('filter-all-count')).toHaveText('3')
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('1')

  await page.getByTestId('filter-waiting').click()
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect(page.getByTestId('thread-row')).toContainText('Pick a database')

  // Unread: the notes nobody opened yet (opening the question thread read it).
  await page.getByTestId('filter-unread').click()
  await expect(row(page, 'Beta note')).toBeVisible()
  await row(page, 'Beta note').click()
  await expect(row(page, 'Beta note')).toHaveCount(0)
  await page.getByTestId('filter-all').click()

  // One session: the list narrows and the terminal follows.
  await selectSession(page, 'alpha')
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect(page.getByTestId('session-filter')).toContainText('alpha')
  await page.getByTestId('session-filter').click()
  await page.getByTestId('session-all').click()
  await expect(page.getByTestId('thread-row')).toHaveCount(3)

  // Grouping by session shows a header per session; by status shows the old sections.
  await page.getByTestId('group-by').click()
  await page.getByTestId('group-session').click()
  await expect(page.getByTestId('group-header')).toHaveCount(3)
  await page.getByTestId('group-by').click()
  await page.getByTestId('group-status').click()
  await expect(page.getByTestId('group-header').first()).toContainText(/waiting/i)
})

test('⌘K still finds threads first, and sessions too', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('gamma')
  const results = page.getByTestId('palette-item')
  // The thread's subject is "Note" (the fake Claude's title); the row says which session it is in.
  await expect(results.and(page.locator('[data-kind="thread"]')).filter({ hasText: 'Note' }).filter({ hasText: 'gamma' }).first()).toBeVisible()
  // The session itself is a hit too: it opens its terminal.
  await page.getByTestId('palette-input').fill('@beta')
  await expect(results.first()).toBeVisible()
  await results.first().click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  // A thread of another session opens that session too.
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('database')
  await page.getByTestId('palette-item').first().click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('thread-subject')).toHaveText('Pick a database')
})

test('phone: the thread list is home; a thread flips to its terminal; the composer picks a session', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
  await expect(page.getByTestId('thread-row')).toHaveCount(3)
  await expect(page.getByTestId('thread-row').first().getByTestId('thread-session')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // Filters work on the phone, and the session sheet filters by session.
  await page.getByTestId('filter-waiting').click()
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await page.getByTestId('filter-all').click()
  await phoneSelectSession(page, 'beta')
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await page.getByTestId('session-filter').click()
  await page.getByTestId('session-all').click()
  await expect(page.getByTestId('thread-row')).toHaveCount(3)

  // Open a thread: the header shows the session chip, which flips to the terminal.
  await row(page, 'Pick a database').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('phone-session-chip')).toContainText('alpha')
  await page.getByTestId('phone-session-chip').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'terminal')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('term-key-esc')).toBeVisible()
  // Thread | Terminal switch while a thread is open; the shell overlay is one tap away.
  await page.getByTestId('mobile-tab-inbox').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await page.getByTestId('phone-session-chip').click()
  await page.getByTestId('shell-toggle').click()
  await expect(page.getByTestId('phone-shell')).toBeVisible()
  await page.getByTestId('shell-close').click()
  await page.getByTestId('mobile-back').click()
  await page.getByTestId('mobile-back').click()
  await expect(page.getByTestId('phone-home')).toBeVisible()

  // The composer's selector works here too, and sends into the picked session.
  await page.getByTestId('composer-target').click()
  await page.getByTestId('session-option').filter({ hasText: 'beta' }).click()
  await expect(page.getByTestId('composer-target-name')).toHaveText('beta')
  await page.getByTestId('quick-body').fill('from the phone')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('phone-session-chip')).toContainText('beta')
  await expect(page.getByTestId('phone-thread-subject')).toHaveText('from the phone')
})

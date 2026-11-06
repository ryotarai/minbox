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
    // The reply box and the quick compose space their textarea and footer row the same (a thread
    // with no open questions, so no counter row sits between the two).
    await row(page, 'Gamma note').click()
    await expect(page.getByTestId('reply-box')).toBeVisible()
    await expect(page.getByTestId('answer-summary')).toHaveCount(0)
    const gaps = await page.evaluate(() => {
      const gap = (ta: string, send: string) => document.querySelector(send)!.getBoundingClientRect().top - document.querySelector(ta)!.getBoundingClientRect().bottom
      return { quick: gap('[data-testid="quick-body"]', '[data-testid="quick-send"]'), reply: gap('[data-testid="reply-box"]', '[data-testid="reply-send"]') }
    })
    expect(Math.abs(gaps.reply - gaps.quick)).toBeLessThanOrEqual(1)
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

test('rows carry no session chip; the thread view shows the session and its terminal', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('thread-row')).toHaveCount(3)
  await expect(page.getByTestId('thread-session')).toHaveCount(0)
  await expect(page.getByTestId('thread-project')).toHaveCount(0)
  await row(page, 'Beta note').click()
  await expect(page.getByTestId('thread-back')).toContainText('beta')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
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
  await expect(page.getByTestId('group-header').first()).toContainText(/needs action/i)
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
  await expect(page.getByTestId('palette-input')).toHaveCount(0) // the first palette has closed
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('database')
  // The list still shows the '@beta' hit until the new query is applied: click only the new first hit.
  await expect(page.getByTestId('palette-item').first()).toContainText('database')
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
  await expect(page.getByTestId('thread-session')).toHaveCount(0)
  await expect(page.getByTestId('thread-project')).toHaveCount(0)
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
  await expect(page.getByTestId('phone-session-name')).toContainText('alpha')
  await page.getByTestId('thread-open-terminal').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'terminal')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('term-key-esc')).toBeVisible()
  // Thread | Terminal switch while a thread is open; the shell overlay is one tap away.
  await page.getByTestId('mobile-tab-inbox').click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await page.getByTestId('thread-open-terminal').click()
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
  await expect(page.getByTestId('phone-session-name')).toContainText('beta')
  await expect(page.getByTestId('phone-thread-subject')).toHaveText('from the phone')
})

// Panes have only minimum widths: one can be dragged until every other pane is at its minimum.
const MIN = { list: 240, thread: 320, terminal: 360, shell: 280 }
for (const width of [1500, 1920, 2560]) {
  test(`desktop ${width}px: panes drag far wider than before, the others keep their minimums, no overflow`, async ({ page, minbox }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'alpha')
    await expectTerminal(page, 'ready>')
    await page.getByTestId('shell-toggle').click()
    await expect(page.getByTestId('shell-pane')).toBeVisible()
    const state = () =>
      page.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
        return { scroll: document.documentElement.scrollWidth, list: r('[data-testid="threads-pane"]').width, thread: r('[data-testid="thread-pane"]').width, main: r('main').width, shell: r('[data-testid="shell-pane"]').width }
      })
    // Resizer centers, left to right: list|thread, thread|terminal, terminal|shell.
    const edges = () => page.getByTestId('resizer').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x + e.getBoundingClientRect().width / 2).sort((a, b) => a - b))
    // Waits until the pane widths stop changing (two identical reads in a row), so asserts never see a mid-drag layout.
    const settled = async () => {
      for (const id of ['threads-pane', 'thread-pane', 'shell-pane']) await expect(page.getByTestId(id)).toBeVisible()
      let prev = ''
      await expect.poll(async () => {
        const cur = JSON.stringify(await state())
        const same = cur === prev
        prev = cur
        return same
      }).toBe(true)
      return state()
    }
    const dragBy = async (x: number, dx: number) => {
      await page.mouse.move(x, 450)
      await page.mouse.down()
      await page.mouse.move(x + dx, 450, { steps: 8 })
      await page.mouse.up()
    }
    // The thread pane grows past the old 900 cap and stops where the terminal is at its minimum.
    await dragBy((await edges())[1]!, width)
    let s = await settled()
    expect(s.scroll).toBeLessThanOrEqual(width)
    // Everything else at its minimum (project column 176, resizers 27): the thread takes the rest.
    expect(s.thread).toBeGreaterThan(width - 176 - MIN.list - MIN.shell - MIN.terminal - 27 - 40)
    if (width >= 2560) expect(s.thread).toBeGreaterThan(1000)
    expect(s.main).toBeGreaterThanOrEqual(MIN.terminal - 1)
    expect(s.main).toBeLessThanOrEqual(MIN.terminal + 40)
    expect(s.list).toBeGreaterThanOrEqual(MIN.list - 1)
    expect(s.shell).toBeGreaterThanOrEqual(MIN.shell - 1)
    // The shell pane grows too (its edge moves left).
    await dragBy((await edges())[2]!, -width)
    s = await settled()
    expect(s.scroll).toBeLessThanOrEqual(width)
    expect(s.shell).toBeGreaterThanOrEqual(width >= 1920 ? 600 : 280)
    expect(s.main).toBeGreaterThanOrEqual(MIN.terminal - 1)
    expect(s.thread).toBeGreaterThanOrEqual(MIN.thread - 1)
    // Shrinking the window never overflows, whatever was stored.
    await page.setViewportSize({ width: 1100, height: 900 })
    // The layout switches bands here and the pane elements briefly vanish: read only scrollWidth.
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1100)
  })
}

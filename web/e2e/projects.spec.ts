import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, phoneSelectProject, selectProject, test, typeInTerminal, type Minbox } from './fixtures'

// Projects: (host, folder) plus a name; sessions and threads are resources under it. The project
// column is the far left of the desktop layout; the phone has a project sheet in the home header.

function folder(m: Minbox, name: string): string {
  const d = join(m.dataDir, name)
  mkdirSync(d, { recursive: true })
  return d
}

/** api/alpha waits on the person (a question); docs/beta has an unread note. */
async function seed(page: Page, m: Minbox) {
  await createSession(page, folder(m, 'api'), 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await createSession(page, folder(m, 'docs'), 'beta')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Beta note')
  await expectTerminal(page, /sent .*thr_/)
  await expect(page.getByTestId('thread-row')).toHaveCount(2)
}

const item = (page: Page, name: string) => page.getByTestId('project-item').filter({ has: page.getByTestId('project-name').getByText(name, { exact: true }) })
const rows = (page: Page) => page.getByTestId('thread-list').getByTestId('thread-row')

test('existing sessions are grouped into projects by folder when the server starts (migration)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  const api = folder(minbox, 'api')
  const docs = folder(minbox, 'docs')
  await createSession(page, api, 'alpha')
  await createSession(page, api, 'alpha2')
  await createSession(page, docs, 'beta')
  await expect(page.getByTestId('project-item')).toHaveCount(2)

  // Make the database look like the build before projects left it, then start the server again.
  await minbox.stop()
  execFileSync('python3', ['-I', '-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('UPDATE sessions SET project_id=NULL'); c.execute('DELETE FROM projects'); c.commit()", join(minbox.dataDir, 'minbox.db')])
  await minbox.start()
  await page.reload()

  await expect(page.getByTestId('project-item')).toHaveCount(2)
  await expect(item(page, 'api')).toBeVisible()
  await expect(item(page, 'docs')).toBeVisible()
  await expect(item(page, 'api').getByTestId('project-dir')).toContainText('api')
  const projects = await (await fetch(minbox.url + '/api/projects')).json()
  expect(projects.map((p: { name: string; session_count: number }) => [p.name, p.session_count]).sort()).toEqual([
    ['api', 2],
    ['docs', 1],
  ])
})

test('All projects shows every thread with its project; a project scopes the list, the terminal and the composer', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)

  await selectProject(page, 'All projects')
  await expect(rows(page)).toHaveCount(2)
  await expect(rows(page).filter({ hasText: 'Pick a database' }).getByTestId('thread-project')).toHaveText('api')
  await expect(rows(page).filter({ hasText: 'Beta note' }).getByTestId('thread-project')).toHaveText('docs')
  // The waiting question is the amber badge of api; docs has one unread thread.
  await expect(item(page, 'api').getByTestId('project-waiting')).toHaveText('1')
  await expect(item(page, 'docs').getByTestId('project-unread')).toHaveText('1')

  await selectProject(page, 'api')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Pick a database')
  await expect(rows(page).first().getByTestId('thread-project')).toHaveCount(0)
  await expect(page.getByTestId('terminal-session-name')).toHaveText('alpha')
  await expect(page.getByTestId('composer-target-name')).toHaveText('alpha')

  await selectProject(page, 'docs')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Beta note')
  await expect(page.getByTestId('terminal-session-name')).toHaveText('beta')
  await expect(page.getByTestId('composer-target-name')).toHaveText('beta')

  await selectProject(page, 'All projects')
  await expect(rows(page)).toHaveCount(2)
  // The choice is remembered by this browser.
  await selectProject(page, 'docs')
  await page.reload()
  await expect(item(page, 'docs')).toHaveAttribute('data-selected', 'true')
})

test('a project is created in a dialog; "+ New session…" in the composer starts a session inside it', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, folder(minbox, 'api'), 'alpha')
  const billing = folder(minbox, 'billing')

  await page.getByTestId('project-new').click()
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible()
  // The folder browser and host choice are the New session ones; there is no kind to choose.
  await expect(page.getByTestId('new-session-kind')).toHaveCount(0)
  await page.getByTestId('new-session-cwd').fill(billing)
  await page.getByTestId('new-session-name').fill('Billing')
  await page.getByTestId('new-session-start').click()
  await expect(item(page, 'Billing')).toHaveAttribute('data-selected', 'true')
  await expect(item(page, 'Billing').getByTestId('project-dir')).toContainText('billing')
  await expect(page.getByTestId('list-empty').or(page.getByTestId('empty-threads'))).toBeVisible()

  // The composer has no session in this project yet: start one there with the text already typed.
  await page.getByTestId('quick-body').fill('Draft the invoice schema')
  await page.getByTestId('composer-target').click()
  await page.getByTestId('composer-new-session').click()
  await expect(page.getByTestId('new-session-project-info')).toContainText(billing)
  // Host and folder come from the project: no folder to pick.
  await expect(page.getByTestId('new-session-cwd')).toHaveCount(0)
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Draft the invoice schema')
  await expect(rows(page)).toHaveCount(1)

  const sessions = await (await fetch(minbox.url + '/api/sessions')).json()
  const projects = await (await fetch(minbox.url + '/api/projects')).json()
  const b = projects.find((p: { name: string }) => p.name === 'Billing')
  const s = sessions.find((x: { project_id: string }) => x.project_id === b.id)
  expect(s.cwd).toBe(billing)
  expect(b.session_count).toBe(1)
})

test('a new session started from All projects asks which project', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  await selectProject(page, 'All projects')
  await page.getByTestId('new-session').click()
  await expect(page.getByTestId('new-session-project')).toBeVisible()
  await page.getByTestId('new-session-project').click()
  await expect(page.getByTestId('new-session-project-option')).toHaveCount(2)
  await page.getByTestId('new-session-project-option').filter({ hasText: 'docs' }).click()
  await expect(page.getByTestId('new-session-project-name')).toHaveText('docs')
  await page.getByTestId('new-session-name').fill('gamma')
  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('gamma')
  await expect(item(page, 'docs')).toHaveAttribute('data-selected', 'true')
  await expect(item(page, 'docs').getByTestId('project-dir')).toContainText('docs')
})

test('the composer targets follow the selected project; All projects groups them by project', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)

  await selectProject(page, 'All projects')
  await page.getByTestId('composer-target').click()
  await expect(page.getByTestId('session-picker-group')).toHaveText(['api', 'docs'])
  await expect(page.getByTestId('session-option')).toHaveCount(2)
  await page.keyboard.press('Escape')

  await selectProject(page, 'api')
  await page.getByTestId('composer-target').click()
  await expect(page.getByTestId('session-option')).toHaveCount(1)
  await expect(page.getByTestId('session-option')).toContainText('alpha')
  await expect(page.getByTestId('session-picker-group')).toHaveCount(0)
})

test('rename; folder and host change only while empty; delete and archive are refused while a session lives', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)

  await item(page, 'docs').hover()
  await item(page, 'docs').getByTestId('project-menu').click()
  await page.getByTestId('project-rename').click()
  await page.getByTestId('project-name-input').fill('manual')
  await page.getByTestId('project-rename-save').click()
  await expect(item(page, 'manual')).toBeVisible()
  await expect(rows(page).filter({ hasText: 'Beta note' }).getByTestId('thread-project')).toHaveText('manual')

  await item(page, 'manual').getByTestId('project-menu').click({ force: true })
  await expect(page.getByTestId('project-edit')).toBeDisabled()
  await page.getByTestId('project-delete').click()
  await expect(page.getByText(/has sessions/).first()).toBeVisible()
  await expect(item(page, 'manual')).toBeVisible()

  await item(page, 'manual').getByTestId('project-menu').click({ force: true })
  await page.getByTestId('project-archive').click()
  await expect(page.getByText(/live session/).first()).toBeVisible()
  await expect(item(page, 'manual')).toBeVisible()

  // An empty project can be moved and deleted.
  const empty = folder(minbox, 'empty')
  await page.getByTestId('project-new').click()
  await page.getByTestId('new-session-cwd').fill(empty)
  await page.getByTestId('new-session-start').click()
  await expect(item(page, 'empty')).toBeVisible()
  await item(page, 'empty').getByTestId('project-menu').click({ force: true })
  await expect(page.getByTestId('project-edit')).toBeEnabled()
  await page.getByTestId('project-delete').click()
  await expect(item(page, 'empty')).toHaveCount(0)
})

test('archiving a project of ended sessions hides it; Restore brings it back', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  await selectProject(page, 'docs')
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-stop').click()
  await expect(page.getByTestId('session-status')).toHaveText(/ended|closed/i)
  await item(page, 'docs').getByTestId('project-menu').click({ force: true })
  await page.getByTestId('project-archive').click()
  await expect(item(page, 'docs')).toHaveCount(0)
  await page.getByTestId('projects-archived-toggle').click()
  await page.getByTestId('project-restore').click()
  await expect(item(page, 'docs')).toBeVisible()
})

test('phone: the project sheet in the home header scopes the list and the composer', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone-home')).toBeVisible()
  await expect(page.getByTestId('project-switch-name')).toHaveText('All projects')
  await expect(rows(page)).toHaveCount(2)

  await page.getByTestId('project-switch').click()
  await expect(page.getByTestId('project-sheet')).toBeVisible()
  await expect(page.getByTestId('project-sheet').getByTestId('project-all')).toBeVisible()
  await expect(page.getByTestId('project-sheet').getByTestId('project-item')).toHaveCount(2)
  await page.getByTestId('project-sheet-close').click()

  await phoneSelectProject(page, 'docs')
  await expect(page.getByTestId('project-switch-name')).toHaveText('docs')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Beta note')
  await expect(page.getByTestId('composer-target-name')).toHaveText('beta')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  await phoneSelectProject(page, 'All projects')
  await expect(rows(page)).toHaveCount(2)
})

test('⌘K: a Projects group switches the project; rows name their project', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  await selectProject(page, 'All projects')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('!docs')
  const hit = page.getByTestId('palette-item').first()
  await expect(hit).toHaveAttribute('data-kind', 'project')
  await page.keyboard.press('Enter')
  await expect(item(page, 'docs')).toHaveAttribute('data-selected', 'true')
  await expect(rows(page)).toHaveCount(1)

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('>all projects')
  await expect(page.getByTestId('palette-item').first()).toContainText('All projects')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('project-all')).toHaveAttribute('aria-pressed', 'true')

  // A thread row shows its project and session; a session its project too.
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('#Beta')
  await expect(page.getByTestId('palette-item').first()).toContainText('docs')
  await page.getByTestId('palette-input').fill('@alpha')
  await expect(page.getByTestId('palette-item').first()).toContainText('api')
  // Opening a thread of another project takes the project along.
  await page.keyboard.press('Escape')
  await selectProject(page, 'api')
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('#Beta')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('thread-subject')).toContainText('Beta note')
  await expect(item(page, 'docs')).toHaveAttribute('data-selected', 'true')
})

for (const width of [1500, 1920]) {
  test(`desktop ${width}px: project column | threads | thread | terminal, nothing overflows`, async ({ page, minbox }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(minbox.url)
    await seed(page, minbox)
    await rows(page).first().click()
    const m = await page.evaluate(() => {
      const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect()
      return { scroll: document.documentElement.scrollWidth, inner: window.innerWidth, rail: r('[data-testid="project-rail"]'), list: r('[data-testid="threads-pane"]'), thread: r('[data-testid="thread-pane"]'), main: r('main') }
    })
    expect(m.scroll).toBeLessThanOrEqual(m.inner)
    expect(m.rail.left).toBeLessThanOrEqual(1)
    expect(m.rail.width).toBeGreaterThanOrEqual(170)
    expect(m.rail.right).toBeLessThanOrEqual(m.list.left + 1)
    expect(m.list.right).toBeLessThanOrEqual(m.thread.left + 1)
    expect(m.thread.right).toBeLessThanOrEqual(m.main.left + 1)
    expect(m.main.right).toBeLessThanOrEqual(m.inner + 0.5)
    expect(m.main.width).toBeGreaterThanOrEqual(width >= 1680 ? 600 : 400)
    await page.getByTestId('shell-toggle').click()
    await expect(page.getByTestId('shell-pane')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  })
}

test('a narrow window shows the project column as tiles; the toggle switches it', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto(minbox.url)
  await seed(page, minbox)
  await expect(page.getByTestId('project-rail')).toHaveAttribute('data-mode', 'tiles')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
  await page.getByTestId('project-rail-toggle').click()
  await expect(page.getByTestId('project-rail')).toHaveAttribute('data-mode', 'names')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1280)
})

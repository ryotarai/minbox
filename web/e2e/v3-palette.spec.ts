// ⌘K quick actions in v3 (main's palette.spec, new-thread-palette.spec and restart.spec's palette
// part): one list of actions, agents, tasks and projects, narrowed as you type; > @ # ! filter;
// Recent; arrows / Ctrl+N/P; Esc; ⌘K from a terminal and a text box; actions act.
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'
import { agentReply, say, startAgent, taskNamed } from './v3'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const items = (page: Page) => page.getByTestId('palette-item')

async function openPalette(page: Page) {
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('palette')).toBeVisible()
  await expect(page.getByTestId('palette-input')).toBeFocused()
}

/** Two agents; alpha has a task "Fix the gauge reading", beta one "日本語のページを直して". */
async function setup(page: Page, m: Parameters<typeof startAgent>[0]) {
  const alpha = await startAgent(m, 'alpha')
  const beta = await startAgent(m, 'beta', 'proj2')
  await say(m, alpha, 'please fix the gauge reading')
  await taskNamed(m, 'Fix the gauge reading')
  await say(m, beta, '日本語のページを直して')
  await taskNamed(m, '日本語のページを直して')
  await agentReply(m, beta, /created a task/)
  await page.goto(m.url)
  await expect(page.getByTestId('board')).toBeVisible()
  return { alpha, beta }
}

test('type to find an agent; Enter opens its stream; ⌘K again closes', async ({ page, minbox }) => {
  const { alpha } = await setup(page, minbox)
  await openPalette(page)
  await page.getByTestId('palette-input').fill('alp')
  await expect(items(page).first()).toHaveAttribute('data-kind', 'agent')
  await expect(items(page).first()).toContainText('alpha')
  await expect(items(page).first().locator('mark')).toHaveText('alp')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('palette')).toHaveCount(0)
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', alpha.id)

  await openPalette(page)
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('palette')).toHaveCount(0)
})

test('a task is found by its title (Japanese too) or its agent, and opens', async ({ page, minbox }) => {
  await setup(page, minbox)
  await openPalette(page)
  await page.getByTestId('palette-input').fill('gauge')
  const row = items(page).first()
  await expect(row).toHaveAttribute('data-kind', 'task')
  await expect(row).toContainText('Fix the gauge reading')
  await expect(row).toContainText('alpha')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')

  // Japanese, across projects; the agent's name finds its tasks too.
  await openPalette(page)
  await page.getByTestId('palette-input').fill('#日本語')
  await expect(items(page).first()).toContainText('日本語のページを直して')
  await page.getByTestId('palette-input').fill('beta ページ')
  await expect(items(page).first()).toContainText('日本語のページを直して')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('task-title')).toHaveText('日本語のページを直して')
})

test('> shows only actions; New agent opens the dialog; # @ ! filter tasks, agents and projects', async ({ page, minbox }) => {
  await setup(page, minbox)
  await openPalette(page)
  await page.getByTestId('palette-input').fill('>')
  await expect(items(page).first()).toHaveAttribute('data-kind', 'action')
  expect(await items(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'action'))).toBe(true)
  await page.getByTestId('palette-input').fill('>new agent')
  await expect(items(page).first()).toHaveAttribute('data-id', 'new-agent')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible()
  await expect(page.getByTestId('new-session-start')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'New session' })).toHaveCount(0)

  await openPalette(page)
  await page.getByTestId('palette-input').fill('>new message')
  await expect(items(page).first()).toHaveAttribute('data-id', 'new-message')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('new-message-dialog')).toBeVisible()
  await page.keyboard.press('Escape')

  await openPalette(page)
  await page.getByTestId('palette-input').fill('#')
  await expect(items(page)).toHaveCount(2)
  expect(await items(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'task'))).toBe(true)
  await page.getByTestId('palette-input').fill('@')
  await expect(items(page)).toHaveCount(2)
  expect(await items(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'agent'))).toBe(true)
  await page.getByTestId('palette-input').fill('!')
  await expect(items(page)).toHaveCount(2)
  expect(await items(page).evaluateAll((els) => els.every((e) => e.getAttribute('data-kind') === 'project'))).toBe(true)
  await expect(page.getByTestId('palette-hint')).toBeVisible()
  // ! picks a project: the sidebar's agents follow.
  await page.getByTestId('palette-input').fill('!proj2')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('agent-row')).toHaveCount(1)
  await expect(page.getByTestId('agent-row')).toContainText('beta')
})

test('arrows and Ctrl+N/P move, Enter on no result does nothing, Esc closes without reaching the terminal', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'esc')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say first')
  await expectTerminal(page, 'sent in')
  await page.getByTestId('terminal').click()
  await page.keyboard.type('say kept')

  await openPalette(page)
  const sel = () => page.locator('[data-testid="palette-item"][data-selected="true"]')
  await page.getByTestId('palette-input').fill('>')
  await expect(sel()).toHaveAttribute('data-id', 'new-message')
  await page.keyboard.press('ArrowDown')
  const second = await sel().getAttribute('data-id')
  expect(second).not.toBe('new-message')
  await page.keyboard.press('Control+n')
  const third = await sel().getAttribute('data-id')
  expect(third).not.toBe(second)
  await page.keyboard.press('Control+p')
  await expect(sel()).toHaveAttribute('data-id', second!)
  await page.keyboard.press('ArrowUp')
  await expect(sel()).toHaveAttribute('data-id', 'new-message')

  await page.getByTestId('palette-input').fill('zzzqqqxxx')
  await expect(items(page)).toHaveCount(0)
  await expect(page.getByTestId('palette-empty')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('palette')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toHaveCount(0)
  // The Esc stayed here: the agent's stream is still open and the typed line is intact.
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await page.getByTestId('terminal').click()
  await page.keyboard.press('Enter')
  await expectTerminal(page, /say kept[\s\S]*sent in[\s\S]*$/)
  expect(await terminalText(page)).not.toContain('^[')
})

test('with an empty query, what was opened last comes first as Recent', async ({ page, minbox }) => {
  await setup(page, minbox)
  await openPalette(page)
  await expect(page.getByText('Recent', { exact: true })).toHaveCount(0)
  await page.getByTestId('palette-input').fill('#gauge')
  await expect(items(page).first()).toContainText('Fix the gauge reading')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')

  await openPalette(page)
  await expect(page.getByText('Recent', { exact: true })).toBeVisible()
  await expect(items(page).first()).toHaveAttribute('data-kind', 'task')
  await expect(items(page).first()).toContainText('Fix the gauge reading')
  const kinds = await items(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))
  expect(kinds.indexOf('action')).toBe(1)
  expect(kinds.lastIndexOf('agent')).toBeGreaterThan(kinds.lastIndexOf('action'))
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('minbox:v3-recent') ?? '[]'))).toHaveLength(1)
})

test('⌘K works from inside the focused terminal and a text box; actions act (shortcuts, settings, shell, files, board)', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('terminal').click()
  await openPalette(page)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('palette')).toHaveCount(0)

  await page.getByTestId('composer-text').click()
  await openPalette(page)
  await page.getByTestId('palette-input').fill('>shortcuts')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('help-dialog')).toBeVisible()
  await expect(page.getByTestId('help-dialog')).toContainText('Quick actions')
  await page.keyboard.press('Escape')

  await openPalette(page)
  await page.getByTestId('palette-input').fill('>show shell')
  await expect(items(page).first()).toHaveAttribute('data-id', 'shell-pane')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('shell-pane')).toBeVisible()
  await expect.poll(() => terminalText(page, 'shell'), { timeout: 15_000 }).not.toBe('')
  await page.waitForTimeout(300)

  // From inside the shell too.
  await openPalette(page)
  await page.getByTestId('palette-input').fill('>show files')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('files-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('shell-pane')).toBeVisible() // beside it, not replaced

  await openPalette(page)
  await page.getByTestId('palette-input').fill('>open board')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('board')).toBeVisible()

  await openPalette(page)
  await page.getByTestId('palette-input').fill('>settings')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/v=settings/)
  // ⌘K on Settings too.
  await openPalette(page)
  await page.getByTestId('palette-input').fill('@alpha')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('stream-view')).toBeVisible()
})

test('the palette restarts the current running agent; the new process gets messages', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'palette-cycler')
  await expectTerminal(page, 'ready>')
  await openPalette(page)
  await page.getByTestId('palette-input').fill('>restart current')
  await expect(items(page).first()).toContainText('Restart current agent')
  await page.getByTestId('palette-input').press('Enter')
  // A new process (the restart resumes the conversation when there is one).
  await expect.poll(() => minbox.log, { timeout: 20_000 }).toMatch(/modconn: spawn session=\S+ resume=true/)
  await expect.poll(() => minbox.log, { timeout: 20_000 }).toMatch(/modconn: spawn session=\S+ resume=true[\s\S]*heartbeat-first/)
  await expect(page.getByTestId('agent-resume')).toHaveCount(0)
  await page.getByTestId('composer-text').fill('After palette restart')
  await page.getByTestId('composer-text').press('ControlOrMeta+Enter')
  await expectTerminal(page, 'After palette restart')
})

test('a click on a row runs it', async ({ page, minbox }) => {
  const { alpha } = await setup(page, minbox)
  await openPalette(page)
  await page.getByTestId('palette-input').fill('@alpha')
  await items(page).first().click()
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', alpha.id)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('the Agents tab’s ⌘ button opens a full-width sheet; a task opens from it', async ({ page, minbox }) => {
    await setup(page, minbox)
    await page.getByTestId('tab-agents').tap()
    await page.getByTestId('open-palette').tap()
    const dialog = page.getByRole('dialog', { name: 'Quick actions' })
    await expect(dialog).toBeVisible()
    const box = (await dialog.boundingBox())!
    expect(box.width).toBeGreaterThan(390 - 40)
    await page.getByTestId('palette-input').fill('#gauge')
    await expect(items(page).first()).toContainText('Fix the gauge reading')
    await page.getByTestId('palette-input').press('Enter')
    await expect(page.getByTestId('task-title')).toHaveText('Fix the gauge reading')
  })
})

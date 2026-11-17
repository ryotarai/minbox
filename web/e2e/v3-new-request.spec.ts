// UC3 (give a new request without thinking where it goes): ⇧N writes to the main agent by default
// (or to a new agent); the agent decides existing task / new task / no task, and says so under its reply.
import { test, expect } from './fixtures'
import { agentReply, api, board, shot, startAgent } from './v3'

test('⇧N to the main agent: new work becomes a task, a follow-up is tagged to it, chit-chat stays untagged', async ({ page, minbox }) => {
  const main = await startAgent(minbox, 'api')
  await page.goto(minbox.url)
  await expect(page.getByTestId('board')).toBeVisible()

  // New work.
  await page.keyboard.press('Shift+N')
  const dlg = page.getByTestId('new-message-dialog')
  await expect(page.getByTestId('new-to')).toHaveValue(main.id)
  await expect(page.getByTestId('new-body')).toBeFocused()
  await page.keyboard.type('please add a dark mode toggle to settings')
  await shot(page, 'uc3-new-message', 'dark')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(dlg).toBeHidden()
  // The view moves to the agent's stream; the reply says what it decided.
  const stream = page.getByTestId('stream-view')
  await expect(stream).toHaveAttribute('data-session', main.id)
  const created = stream.locator('[data-testid="decision"][data-decision="created"]')
  await expect(created).toBeVisible({ timeout: 15_000 })
  await expect(created).toContainText('Add a dark mode toggle to settings')
  // The person's message got the new task's tag retroactively.
  const mine = stream.locator('[data-testid="v3-message"][data-author="user"]').first()
  await expect(mine.getByTestId('tag')).toHaveAttribute('title', 'Add a dark mode toggle to settings')

  // A follow-up about it: tagged with the existing task.
  await page.getByTestId('composer-text').fill('the dark toggle should remember the choice')
  await page.getByTestId('composer-send').click()
  await expect(stream.locator('[data-testid="decision"][data-decision="existing"]')).toBeVisible({ timeout: 15_000 })

  // Chit-chat: no task.
  await page.getByTestId('composer-text').fill('is the staging server up?')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(stream.locator('[data-testid="decision"][data-decision="none"]')).toBeVisible({ timeout: 15_000 })
  await shot(page, 'uc3-decisions', 'light')
  const b = await board(minbox)
  expect(b.tasks.map((t: any) => t.title)).toEqual(['Add a dark mode toggle to settings'])
  expect(b.tasks[0].message_count).toBe(4)
})

test('⇧N to a new agent starts a session and its stream gets the message', async ({ page, minbox }) => {
  const main = await startAgent(minbox, 'api')
  await page.goto(minbox.url)
  await page.getByTestId('new-message').click()
  await page.getByTestId('new-to').selectOption('new')
  await page.getByLabel('Agent name').fill('helper')
  await page.getByTestId('new-body').fill('is the staging server up?')
  await page.getByTestId('new-send').click()
  const stream = page.getByTestId('stream-view')
  await expect(page.getByTestId('agent-name')).toHaveText('helper')
  await expect(stream.locator('[data-testid="decision"][data-decision="none"]')).toBeVisible({ timeout: 20_000 })
  const sessions = await api(minbox, 'GET', '/api/sessions')
  expect(sessions.map((s: any) => s.name).sort()).toEqual(['api', 'helper'])
  expect(sessions.find((s: any) => s.name === 'helper').id).not.toBe(main.id)
  await expect(page.getByTestId('agent-row')).toHaveCount(2)
})

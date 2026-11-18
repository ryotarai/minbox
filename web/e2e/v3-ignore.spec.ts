// Ignore a moot question: from the Board row (its ⋯ menu, right-click, I on the focused row) or from the
// question card. It stops waiting on the person (NEEDS YOU, the badge, the task's needs you), the card
// reads Ignored, and Undo / Reopen brings it back. Nothing is sent to the agent.
import { test, expect } from './fixtures'
import { agentReply, api, board, say, startAgent, taskNamed } from './v3'
import type { Page } from '@playwright/test'

async function asked(minbox: any) {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.needs_you).toBe(true)
  return { a, t, q }
}

async function expectNeeds(page: Page, n: number) {
  await expect(page.getByTestId('needs-count')).toHaveText(`${n} need you`)
  if (n) await expect(page.getByTestId('board-badge')).toHaveText(String(n))
  else await expect(page.getByTestId('board-badge')).toHaveCount(0)
}

test('ignore from the Board row menu: the row goes, counts drop, the task no longer needs you; Undo brings it back', async ({ page, minbox }) => {
  const { a, t } = await asked(minbox)
  await page.goto(minbox.url)
  const row = page.getByTestId('group-needs_you').getByTestId('question-card')
  await expect(row).toHaveCount(1)
  await expectNeeds(page, 1)

  await row.getByTestId('question-row-more').click()
  await page.getByTestId('menu-ignore-question').click()
  await expect(row).toHaveCount(0)
  await expectNeeds(page, 0)
  // The agent's own count (the sidebar's and the tab's attention) drops too.
  await expect.poll(async () => (await api(minbox, 'GET', '/api/sessions')).find((x: any) => x.id === a.id)?.open_questions).toBe(0)
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.needs_you).toBe(false)
  expect((await board(minbox)).tasks.find((x: any) => x.id === t.id)?.status).toBe('working')
  // Nothing went to the agent.
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  expect(s.messages.filter((m: any) => m.author === 'user')).toHaveLength(2)

  // The toast's Undo reopens it.
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(row).toHaveCount(1)
  await expectNeeds(page, 1)
})

test('ignore with I on the focused row, and right-click', async ({ page, minbox }) => {
  await asked(minbox)
  await page.goto(minbox.url)
  const row = page.getByTestId('group-needs_you').getByTestId('question-card')
  await expect(row).toHaveCount(1)
  await page.keyboard.press('j')
  await expect(row).toHaveClass(/\bfocus\b/)
  await page.keyboard.press('i')
  await expect(row).toHaveCount(0)
  await expectNeeds(page, 0)
  // Z undoes it (once the toast is up).
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
  await page.keyboard.press('z')
  await expect(row).toHaveCount(1)
  await expectNeeds(page, 1)

  // Right-click: the same menu; a click on the row itself still opens the task.
  await row.click({ button: 'right' })
  await expect(page.getByTestId('question-row-menu')).toBeVisible()
  await page.getByTestId('menu-ignore-question').click()
  await expect(row).toHaveCount(0)
  await expectNeeds(page, 0)
})

test('ignore from the question card: it reads Ignored, the task no longer needs you; Reopen opens it again', async ({ page, minbox }) => {
  const { t, q } = await asked(minbox)
  await page.goto(`${minbox.url}/#v=task&k=${t.id}`)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  const block = msg.getByTestId('question')
  await expect(block).toHaveAttribute('data-open', 'true')
  await block.getByTestId('ignore-question').click()
  await expect(block).toHaveAttribute('data-open', 'false')
  await expect(block.getByTestId('question-state')).toHaveText('Ignored')
  await expect(block.getByTestId('question-ignored')).toContainText('Ignored')
  await expect(block.getByTestId('choice').first()).toBeDisabled()
  await expect(page.getByTestId('board-badge')).toHaveCount(0)
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.needs_you).toBe(false)
  expect((await board(minbox)).questions).toHaveLength(0)

  await block.getByTestId('unignore-question').click()
  await expect(block).toHaveAttribute('data-open', 'true')
  await expect(page.getByTestId('board-badge')).toHaveText('1')
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.needs_you).toBe(true)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('the card has Ignore on a phone', async ({ page, minbox }) => {
    const { a, q } = await asked(minbox)
    await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
    const block = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`).getByTestId('question')
    await block.getByTestId('ignore-question').tap()
    await expect(block.getByTestId('question-state')).toHaveText('Ignored')
    await expect.poll(async () => (await board(minbox)).questions.length).toBe(0)
  })
})

// Ignore a moot question from its card: it stops waiting on the person (the task's "? n"), the card
// reads Ignored, and Reopen brings it back. Nothing is sent to the agent, and the task's status (so
// NEEDS YOU) is not touched: NEEDS YOU is the tasks set to needs you, never single questions.
import { test, expect } from './fixtures'
import { agentReply, api, board, openAsks, say, startAgent, taskNamed } from './v3'

async function asked(minbox: any) {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.open_questions).toBe(1)
  return { a, t, q }
}

test('ignore from the question card: it reads Ignored, the task has no open question; Reopen opens it again', async ({ page, minbox }) => {
  const { a, t, q } = await asked(minbox)
  await page.goto(`${minbox.url}/#v=task&k=${t.id}`)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  const block = msg.getByTestId('question')
  await expect(block).toHaveAttribute('data-open', 'true')
  await block.getByTestId('ignore-question').click()
  await expect(block).toHaveAttribute('data-open', 'false')
  await expect(block.getByTestId('question-state')).toHaveText('Ignored')
  await expect(block.getByTestId('question-ignored')).toContainText('Ignored')
  await expect(block.getByTestId('choice').first()).toBeDisabled()
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.open_questions).toBe(0)
  expect(await openAsks(minbox, a)).toBe(0)
  // The status is the agent's: still working, nothing in NEEDS YOU before or after.
  expect((await board(minbox)).tasks.find((x: any) => x.id === t.id)?.status).toBe('working')
  await expect(page.getByTestId('board-badge')).toHaveCount(0)
  // Nothing went to the agent.
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  expect(s.messages.filter((m: any) => m.author === 'user')).toHaveLength(2)

  await block.getByTestId('unignore-question').click()
  await expect(block).toHaveAttribute('data-open', 'true')
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.open_questions).toBe(1)
  await expect(page.getByTestId('board-badge')).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('the card has Ignore on a phone', async ({ page, minbox }) => {
    const { a, q } = await asked(minbox)
    await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
    const block = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`).getByTestId('question')
    await block.getByTestId('ignore-question').tap()
    await expect(block.getByTestId('question-state')).toHaveText('Ignored')
    await expect.poll(async () => openAsks(minbox, a)).toBe(0)
  })
})

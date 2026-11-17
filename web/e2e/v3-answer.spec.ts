// UC2 (answer a question fast): one click on a choice answers, on the Board and inside the task or
// stream; the answer goes to the agent that asked, tagged with the question's task.
import { test, expect } from './fixtures'
import { agentReply, api, board, say, startAgent, taskNamed } from './v3'

test('a choice in the stream answers in one click; the answer is tagged with the task', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  await page.goto(`${minbox.url}/#v=task&k=${t.id}`)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'true')
  await msg.getByTestId('question').getByText('Oregon', { exact: true }).click()
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
  await agentReply(minbox, a, /carrying on/)
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  const ans = s.messages.find((m: any) => m.answers_for === q.id)
  expect(ans.tags.map((x: any) => x.task_id)).toEqual([t.id])
  expect((await board(minbox)).questions).toHaveLength(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('a question card answers with one tap on the phone', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await say(minbox, a, 'ASK about the deploy')
    await agentReply(minbox, a, /One decision first/)
    await page.goto(minbox.url)
    const card = page.getByTestId('question-card')
    await expect(card).toContainText('Which region')
    await card.getByTestId('choice').filter({ hasText: 'Tokyo' }).tap()
    await expect(card).toHaveCount(0)
    await agentReply(minbox, a, /carrying on/)
  })
})

// UC2 (answer a question fast): a pick only selects; Send (or ⌘↵) sends the picked answers inside the
// task or stream; the answer goes to the agent that asked, about the question's task.
import { test, expect } from './fixtures'
import { agentReply, api, openAsks, say, startAgent, taskNamed } from './v3'

test('in the task view a pick selects, Send sends; the answer is about the task', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  await page.goto(`${minbox.url}/#s=${a.id}&v=agent&k=${t.id}`)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'true')
  await msg.getByTestId('question').getByText('Tokyo', { exact: true }).click()
  // Nothing is sent yet: the pick can change.
  await expect(msg.getByTestId('answer-bar')).toContainText('1 of 1 answered')
  await msg.getByTestId('question').getByText('Oregon', { exact: true }).click()
  await page.waitForTimeout(300)
  expect(await openAsks(minbox, a)).toBe(1)
  // The pick survives a reload (a draft), then Send sends it.
  await page.reload()
  await expect(msg.getByTestId('answer-bar')).toContainText('1 of 1 answered')
  await msg.getByTestId('send-answers').click()
  await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
  await agentReply(minbox, a, /carrying on/)
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  const ans = s.messages.find((m: any) => m.answers_for === q.id)
  expect(ans.answers[0].selected).toEqual(['Oregon'])
  expect(ans.tasks.map((x: any) => x.task_id)).toEqual([t.id])
  expect(await openAsks(minbox, a)).toBe(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('a question in the agent stream: tap a choice, then Send', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await say(minbox, a, 'ASK about the deploy')
    const q = await agentReply(minbox, a, /One decision first/)
    await page.goto(`${minbox.url}/#s=${a.id}&v=agent`)
    const msg = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
    await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'true')
    await msg.getByTestId('question').getByText('Tokyo', { exact: true }).tap()
    await msg.getByTestId('send-answers').tap()
    await expect(msg.getByTestId('question')).toHaveAttribute('data-open', 'false')
    await agentReply(minbox, a, /carrying on/)
    await expect.poll(async () => openAsks(minbox, a)).toBe(0)
  })
})

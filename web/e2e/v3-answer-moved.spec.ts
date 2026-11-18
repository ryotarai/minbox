// The person's answers read on their own: next to the message with the questions they are a short "↳"
// line (that message's cards show them); moved to another task (or anywhere that message is not shown
// just above) they show each question's prompt with the choice and the note, and "↳" reveals the question.
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

async function ask(minbox: any) {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  return { a, t, q, key: q.questions[0].key as string }
}

test('an answer next to its question is a short line, as before', async ({ page, minbox }) => {
  const { a, t, q, key } = await ask(minbox)
  const ans = await api(minbox, 'POST', `/api/v3/sessions/${a.id}/messages`, { words: '', answers_for: q.id, answers: [{ key, selected: ['Oregon'] }] })
  await agentReply(minbox, a, /carrying on/)
  for (const url of [`${minbox.url}/#v=task&k=${t.id}`, `${minbox.url}/#v=agent&s=${a.id}`]) {
    await page.goto(url)
    const msg = page.locator(`[data-testid="v3-message"][data-message-id="${ans.id}"]`)
    await expect(msg.getByTestId('sent-answers')).toHaveText('↳ Oregon')
    await expect(msg.getByTestId('answer-content')).toHaveCount(0)
  }
})

test('an answer moved to another task shows the question, the choice and the note; ↳ reveals the question', async ({ page, minbox }) => {
  const { a, t, q, key } = await ask(minbox)
  // A note alone (no choice): the answer of the bug report, which showed as an empty "↳".
  const ans = await api(minbox, 'POST', `/api/v3/sessions/${a.id}/messages`, { words: '', answers_for: q.id, answers: [{ key, note: 'Make it an error instead of ignoring it' }] })
  await agentReply(minbox, a, /carrying on/)
  const t2 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Make the status an error', session_id: a.id, message_ids: [ans.id] })

  await page.goto(`${minbox.url}/#v=task&k=${t2.id}`)
  const msg = page.locator(`[data-testid="v3-message"][data-message-id="${ans.id}"]`)
  const c = msg.getByTestId('answer-content')
  await expect(c.getByTestId('answer-to')).toContainText('Answer to api: “One decision first.”')
  await expect(c.getByTestId('answer-item')).toContainText('Which region should it deploy to?')
  await expect(c.getByTestId('answer-item')).toContainText('Note: Make it an error instead of ignoring it')
  await expect(msg.getByTestId('sent-answers')).toHaveCount(0)

  // ↳ opens the question in its task, highlighted.
  await c.getByTestId('answer-to').click()
  await expect(page).toHaveURL(new RegExp(`k=${t.id}`))
  const question = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`)
  await expect(question).toHaveClass(/\bhl\b/)
  await expect(question.getByTestId('question')).toHaveAttribute('data-open', 'false')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('a moved answer with a choice and a note reads on its own', async ({ page, minbox }) => {
    const { a, q, key } = await ask(minbox)
    const ans = await api(minbox, 'POST', `/api/v3/sessions/${a.id}/messages`, { words: '', answers_for: q.id, answers: [{ key, selected: ['Tokyo'], note: 'cheaper' }] })
    await agentReply(minbox, a, /carrying on/)
    const t2 = await api(minbox, 'POST', '/api/v3/tasks', { title: 'Deploy region', session_id: a.id, message_ids: [ans.id] })
    await page.goto(`${minbox.url}/#v=task&k=${t2.id}`)
    const item = page.locator(`[data-testid="v3-message"][data-message-id="${ans.id}"]`).getByTestId('answer-item')
    await expect(item).toContainText('Which region should it deploy to?')
    await expect(item).toContainText('Tokyo')
    await expect(item).toContainText('Note: cheaper')
    // No horizontal overflow on a phone.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
})

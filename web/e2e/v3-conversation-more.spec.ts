// More of the conversation (as the thread view before v3): R right after a mouse selection quotes it;
// Accept recommended; action items' Done / Can't do go with Send; a task view opens at its newest
// message; on a phone the message menu starts a new thread.
import { test, expect, expectTerminal, typeInTerminal } from './fixtures'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

test('R right after a double-click selection quotes it into the reply box', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'is the staging server up?')
  const r = await agentReply(minbox, a, /Sure — noted/)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const p = page.locator(`[data-testid="v3-message"][data-message-id="${r.id}"] .v-bd p`).first()
  await p.dblclick({ position: { x: 6, y: 6 } })
  await page.keyboard.press('r')
  await expect(page.getByTestId('composer-text')).toHaveValue(/^> Sure/)
  await expect(page.getByTestId('composer-text')).toBeFocused()
})

test('Accept recommended picks it (and says Switch once another is picked); Send answers', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'ASK about the deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const card = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`).getByTestId('question-card')
  const btn = card.getByTestId('accept-recommended')
  await expect(btn).toHaveText('Accept recommended')
  await card.getByTestId('choice').filter({ hasText: 'Oregon' }).click()
  await expect(btn).toHaveText('Switch to recommended')
  await btn.click()
  await expect(btn).toHaveCount(0)
  await page.getByTestId('composer-send').click()
  await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)).messages.find((m: any) => m.answers_for === q.id)?.answers[0].selected).toEqual(['Tokyo'])
})

test('action items: Done and Can’t do it go with Send and reach the agent', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await typeInTerminal(page, 'actions')
  await expectTerminal(page, /sent actions in thr_/)
  const items = page.getByTestId('action-item')
  await expect(items).toHaveCount(2)
  await items.nth(0).getByTestId('action-done').click()
  await items.nth(1).getByTestId('action-cant').click()
  await expect(page.getByTestId('picks-chip')).toContainText('2 picks')
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('picks-chip')).toHaveCount(0)
  await expectTerminal(page, /Add the GitHub labels/)
  await expect(items.nth(0)).toHaveAttribute('data-state', /done/i)
})

test('a task view opens at its newest message', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  for (let i = 0; i < 12; i++) await say(minbox, a, `gauge reading note ${i} ` + 'with a long line of text '.repeat(8), [t.id])
  await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)).messages.length, { timeout: 30_000 }).toBeGreaterThan(20)
  const d = await api(minbox, 'GET', `/api/v3/tasks/${t.id}`)
  await api(minbox, 'POST', '/api/v3/read', { message_ids: d.messages.map((m: any) => m.id) })
  await page.goto(`${minbox.url}/#v=task&k=${t.id}`)
  const scroller = page.getByTestId('task-view').locator('.v-scroll')
  await expect(page.getByTestId('task-view').locator('[data-testid="v3-message"]').first()).toBeVisible()
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 200 && el.scrollHeight - el.scrollTop - el.clientHeight < 60)).toBe(true)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('the message menu starts a new thread from a message', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await say(minbox, a, 'is the staging server up?')
    const r = await agentReply(minbox, a, /Sure — noted/)
    await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
    await page.locator(`[data-testid="v3-message"][data-message-id="${r.id}"]`).getByTestId('msg-menu').tap()
    await page.getByTestId('message-fork-item').tap()
    await expect(page.getByTestId('fork-dialog')).toBeVisible()
  })
})

test('E marks the conversation read and goes back to the Board', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'hello')
  await agentReply(minbox, a, /Sure — noted/)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('composer-text')).toBeVisible()
  const st = (await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)).stream_thread_id
  await page.locator('body').click({ position: { x: 900, y: 10 } })
  await page.keyboard.press('e')
  await expect(page.getByTestId('board')).toBeVisible()
  await expect.poll(async () => (await api(minbox, 'GET', `/api/threads/${st}`)).marked_read_at).not.toBeNull()
})

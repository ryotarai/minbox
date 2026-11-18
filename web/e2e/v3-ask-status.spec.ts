// "Ask for status" beside a working task's "<agent> is working on this…" line: it sends "このタスクの状況は？"
// to the agent about the task (as the task composer sends), shows "Sent" for a while (disabled), and leaves
// the composer's draft alone. Not shown when the task is not Working.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { expect, test } from './fixtures'
import { agentReply, api, say, startAgent, taskNamed } from './v3'

test('a working task: Ask for status sends "このタスクの状況は？" to its agent about the task; the draft stays', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}&k=${t.id}`)
  const line = page.getByTestId('working-line')
  const ask = line.getByTestId('ask-status')
  await expect(ask).toBeVisible()
  await expect(ask).toHaveText('Ask for status')
  // To the right of the words, on the same line.
  const lb = (await line.locator('.v-typing-t').boundingBox())!
  const ab = (await ask.boundingBox())!
  expect(ab.x).toBeGreaterThan(lb.x + lb.width)
  expect(Math.abs(ab.y + ab.height / 2 - (lb.y + lb.height / 2))).toBeLessThan(6)

  const tbox = page.getByTestId('task-composer').getByTestId('composer-text')
  await tbox.fill('half-written thought')
  await ask.click()
  await expect(ask).toHaveText('Sent')
  await expect(ask).toBeDisabled()
  await expect(tbox).toHaveValue('half-written thought')

  // In the task's conversation, as the person's message; on the server, to the agent, about the task.
  const mine = page.getByTestId('task-column').locator('[data-testid="v3-message"][data-author="user"]').filter({ hasText: 'このタスクの状況は？' })
  await expect(mine).toHaveCount(1)
  let sent: any = null
  await expect
    .poll(async () => {
      const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
      sent = s.messages.find((m: any) => m.author === 'user' && m.words === 'このタスクの状況は？')
      return sent?.delivered_at ? 'delivered' : sent ? 'sent' : 'none'
    }, { timeout: 15_000 })
    .toBe('delivered')
  expect(sent.tasks.map((x: any) => x.task_id)).toEqual([t.id])
  // The fake agent took it in its turn, with the task attached, and answered about it.
  await agentReply(minbox, a, /Noted for “Fix the gauge reading”/)

  if (process.env.ASK_STATUS_SHOT) {
    await page.goto(`${minbox.url}/#v=agent&s=${a.id}&k=${t.id}`)
    await expect(ask).toHaveText('Ask for status', { timeout: 10_000 })
    mkdirSync(dirname(process.env.ASK_STATUS_SHOT), { recursive: true })
    await page.getByTestId('task-column').screenshot({ path: process.env.ASK_STATUS_SHOT })
  }

  // Back to idle after a few seconds; gone when the task is not Working.
  await expect(ask).toHaveText('Ask for status', { timeout: 10_000 })
  await expect(ask).toBeEnabled()
  await api(minbox, 'PATCH', `/api/v3/tasks/${t.id}`, { status: 'needs_you' })
  await expect(page.getByTestId('ask-status')).toHaveCount(0)
})

test('phone: the button sits on the working line too', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}&k=${t.id}`)
  const ask = page.getByTestId('working-line').getByTestId('ask-status')
  await expect(ask).toBeVisible()
  await ask.click()
  await expect(ask).toHaveText('Sent')
  await expect.poll(async () => (await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)).messages.some((m: any) => m.words === 'このタスクの状況は？')).toBe(true)
})

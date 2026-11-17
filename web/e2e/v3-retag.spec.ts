// UC7 (correct a wrong tag): "wrong task?" under the reply moves the reply and the person's message
// together; a task the agent made by mistake goes. "tag it?" tags an untagged exchange; ✕ removes a tag.
import { test, expect } from './fixtures'
import { agentReply, board, say, shot, startAgent, taskNamed } from './v3'

test('wrong task? moves both messages and removes the mistaken task; tag it? and ✕', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const gauge = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  // The agent wrongly makes a new task for what is really the gauge work.
  await say(minbox, a, 'please update the needle color')
  await taskNamed(minbox, /Update the needle color/)
  await agentReply(minbox, a, /Update the needle color/)

  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  const stream = page.getByTestId('stream-view')
  const note = stream.locator('[data-testid="decision"][data-decision="created"]').last()
  await expect(note).toContainText('Update the needle color')
  await note.getByTestId('wrong-task').click()
  const picker = page.getByTestId('tag-picker')
  await expect(picker).toContainText('Move the tag from')
  await page.keyboard.type('gauge')
  await shot(page, 'uc7-retag', 'dark')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Removed the mistaken task “Update the needle color”')).toBeVisible()
  await expect(stream.locator('[data-testid="decision"][data-decision="moved"]')).toBeVisible()
  await expect.poll(async () => (await board(minbox)).tasks.map((t: any) => t.title)).toEqual(['Fix the gauge reading'])
  const t = (await board(minbox)).tasks[0]
  expect(t.id).toBe(gauge.id)
  expect(t.message_count).toBe(4)

  // tag it? on a reply with no task: tags it and the person's message.
  await say(minbox, a, 'is the staging server up?')
  await agentReply(minbox, a, /Sure — noted/)
  const none = stream.locator('[data-testid="decision"][data-decision="none"]')
  await none.getByTestId('wrong-task').click()
  await page.keyboard.type('gauge')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await board(minbox)).tasks[0].message_count).toBe(6)

  // ✕ on a chip takes the tag off that message only.
  const last = stream.locator('[data-testid="v3-message"][data-author="user"]').last()
  await last.hover()
  await last.getByRole('button', { name: /Remove tag/ }).click()
  await expect.poll(async () => (await board(minbox)).tasks[0].message_count).toBe(5)
})

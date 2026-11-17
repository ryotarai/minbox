// UC8 (find something said last week): / searches tasks and messages; a message opens its agent's
// stream scrolled to it and highlighted.
import { test, expect } from './fixtures'
import { agentReply, say, shot, startAgent, taskNamed } from './v3'

test('/ finds tasks and messages; a message opens its stream at the message', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the zeppelin gauge')
  await taskNamed(minbox, /zeppelin/)
  await agentReply(minbox, a, /created a task/)
  for (let i = 0; i < 6; i++) {
    await say(minbox, a, `is the staging server up? (${i})`)
    await agentReply(minbox, a, new RegExp('Sure — noted'))
  }
  await page.goto(minbox.url)
  await page.keyboard.press('/')
  await expect(page.getByTestId('search-input')).toBeFocused()
  await page.keyboard.type('zeppelin')
  await expect(page.getByTestId('search-task')).toHaveCount(1)
  await expect(page.getByTestId('search-message')).toHaveCount(2)
  await expect(page.getByTestId('search-message').first().locator('mark')).toHaveText('zeppelin')
  await shot(page, 'uc8-search', 'light')
  await page.getByTestId('search-message').filter({ hasText: 'You →' }).click()
  const hl = page.locator('.v-msg.hl')
  await expect(hl).toContainText('please fix the zeppelin gauge')
  await expect(hl).toBeInViewport()
  // The task result opens the task.
  await page.keyboard.press('/')
  await page.keyboard.type('zeppelin')
  await page.getByTestId('search-task').click()
  await expect(page.getByTestId('task-title')).toContainText('zeppelin')
})

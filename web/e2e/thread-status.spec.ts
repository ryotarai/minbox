import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Thread status: working | need_action | finished, set by the person's messages, the agent's
// send_message `status`, a message with questions, and by hand.

const row = (page: Page, text: string) => page.getByTestId('thread-list').getByTestId('thread-row').filter({ hasText: text })
const badge = (page: Page, text: string) => row(page, text).getByTestId('thread-status')

test('status badges follow the agent, the person and the Mark as menu; filters and grouping use them', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')

  // A question: needs action.
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await expect(badge(page, 'Pick a database')).toHaveAttribute('data-status', 'need_action')
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('1')

  // The agent says it is working, then finished (in a second session; `mark` continues its last thread).
  await createSession(page, minbox.dataDir, 'beta')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'mark working Starting')
  await expect(badge(page, 'Status note')).toHaveAttribute('data-status', 'working')
  await typeInTerminal(page, 'mark done All done')
  await expectTerminal(page, /marked thr_[\s\S]*marked thr_/)
  await expect(badge(page, 'Status note')).toHaveAttribute('data-status', 'finished')
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('1')

  // The person replies in the finished thread: working.
  await row(page, 'Status note').click()
  await expect(page.getByTestId('thread-view').getByTestId('thread-status')).toHaveAttribute('data-status', 'finished')
  await page.getByTestId('reply-box').fill('One more thing')
  await page.getByTestId('reply-send').click()
  await expect(badge(page, 'Status note')).toHaveAttribute('data-status', 'working')
  await expect(page.getByTestId('thread-view').getByTestId('thread-status')).toHaveAttribute('data-status', 'working')

  // By hand, from the More menu.
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-mark-need_action').click()
  await expect(badge(page, 'Status note')).toHaveAttribute('data-status', 'need_action')
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('2')
  await page.getByTestId('thread-more').click()
  await page.getByTestId('thread-mark-finished').click()
  await expect(badge(page, 'Status note')).toHaveAttribute('data-status', 'finished')
  await expect(page.getByTestId('filter-waiting-count')).toHaveText('1')

  // Grouping by status: needs action first, finished last.
  await page.getByTestId('group-by').click()
  await page.getByTestId('group-status').click()
  const headers = page.getByTestId('group-header')
  await expect(headers).toHaveCount(2)
  await expect(headers.first()).toContainText(/needs action/i)
  await expect(headers.last()).toContainText(/finished/i)

  // The Waiting filter keeps only the thread that needs action.
  await page.getByTestId('filter-waiting').click()
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect(page.getByTestId('thread-row')).toContainText('Pick a database')
})

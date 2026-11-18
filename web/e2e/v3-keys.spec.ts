// Keyboard parity with main (v2.spec's N / Z / single-key setting, the shortcuts overlay): N opens
// the next agent with unread messages, Z undoes Done, Settings › single-key shortcuts off turns the
// letters off (⌘K stays), and ? lists every key.
import { expect, test } from './fixtures'
import { agentReply, api, board, say, startAgent, taskNamed } from './v3'

test('N opens the next agent with unread messages; X marks the focused task done and Z puts it back', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'alpha')
  const b = await startAgent(minbox, 'beta')
  await say(minbox, b, 'please fix the gauge reading')
  const t = await taskNamed(minbox, 'Fix the gauge reading')
  await agentReply(minbox, b, /created a task/)
  await page.goto(minbox.url)
  await expect(page.getByTestId('board')).toBeVisible()
  await page.keyboard.press('n')
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', b.id)
  void a

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('board')).toBeVisible()
  // Focus the task's row and mark it done; Z undoes it.
  for (let i = 0; i < 5; i++) {
    if ((await page.locator(`[data-testid="task-row"][data-task="${t.id}"].focus`).count()) > 0) break
    await page.keyboard.press('j')
  }
  await expect(page.locator(`[data-testid="task-row"][data-task="${t.id}"]`)).toHaveClass(/focus/)
  await page.keyboard.press('x')
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.status).toBe('done')
  await expect(page.getByText('Done: “Fix the gauge reading”')).toBeVisible()
  await page.keyboard.press('z')
  await expect.poll(async () => (await board(minbox)).tasks.find((x: any) => x.id === t.id)?.status).not.toBe('done')
})

test('single-key shortcuts off: letters do nothing, ⌘K still opens the palette; ? lists the keys', async ({ page, minbox }) => {
  await startAgent(minbox, 'alpha')
  await page.goto(minbox.url)
  await page.keyboard.press('?')
  const help = page.getByTestId('help-dialog')
  await expect(help).toBeVisible()
  for (const k of ['K', '⇧N', '⇧F', 'N', 'Z', 'Ctrl+`', 'T', '/']) await expect(help.locator('.v-kbd', { hasText: k }).first()).toBeVisible()
  await page.keyboard.press('Escape')

  await api(minbox, 'PUT', '/api/settings', { single_key: false })
  await page.reload()
  await expect(page.getByTestId('board')).toBeVisible()
  await page.keyboard.press('/')
  await page.keyboard.press('?')
  await expect(page.getByTestId('search-view')).toHaveCount(0)
  await expect(help).toHaveCount(0)
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`)
  await expect(page.getByTestId('palette')).toBeVisible()
})

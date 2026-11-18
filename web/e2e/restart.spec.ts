import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

// Restart of a RUNNING session: stop, wait for the exit, resume with `claude --resume`.

// The menu restart (and the palette's) of v3: v3-agents.spec.ts and v3-palette.spec.ts.

test('declining the confirm leaves the session as it is', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'stayer')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say keep')
  await expectTerminal(page, 'sent in')
  page.once('dialog', (d) => void d.dismiss())
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-restart').click()
  await page.waitForTimeout(800)
  expect(await terminalText(page)).toContain('say keep')
})

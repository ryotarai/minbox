import { createSession, expect, expectTerminal, sessionStatus, terminalText, test, typeInTerminal } from './fixtures'
import type { Page } from '@playwright/test'

// Restart of a RUNNING session: stop, wait for the exit, resume with `claude --resume`.

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function sendQuick(page: Page, body: string) {
  await page.getByTestId('quick-body').fill(body)
  await page.getByTestId('quick-send').click()
}

test('the session menu restarts a running session; the new process gets messages', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'cycler')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say before')
  await expectTerminal(page, 'sent in')

  page.once('dialog', (d) => void d.accept())
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-restart').click()

  // The session carries on (never shown as ended for good) with a new process.
  await expect(sessionStatus(page)).toContainText('Waiting for you', { timeout: 20_000 })
  await expect(page.getByTestId('resume')).toHaveCount(0)
  await expect.poll(() => terminalText(page), { timeout: 20_000 }).toMatch(/fake-claude (new|resume) session=[\s\S]*ready>/)
  // The terminal is connected to the new process.
  // (the socket may still be reconnecting when the text first shows: type until it takes)
  await expect
    .poll(
      async () => {
        const t = await terminalText(page)
        if (!/sent in/.test(t)) await typeInTerminal(page, 'say after')
        return /sent in/.test(await terminalText(page))
      },
      { timeout: 20_000, intervals: [1500] },
    )
    .toBe(true)
  // A message sent afterwards reaches the new process.
  await sendQuick(page, 'Hello again')
  await expectTerminal(page, '<<< inbox [Hello again]')
})

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

test('the palette restarts the current running session', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'palette-cycler')
  await expectTerminal(page, 'ready>')
  await page.keyboard.press(`${MOD}+k`)
  await page.getByTestId('palette-input').fill('>restart current')
  await expect(page.getByTestId('palette-item').first()).toContainText('Restart current session')
  await page.keyboard.press('Enter')
  await expect(sessionStatus(page)).toContainText('Waiting for you', { timeout: 20_000 })
  await expect(page.getByTestId('resume')).toHaveCount(0)
  await sendQuick(page, 'After palette restart')
  await expectTerminal(page, '<<< inbox [After palette restart]')
})

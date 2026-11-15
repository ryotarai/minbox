import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, showTerminal, terminalText, test, typeInTerminal, type Minbox } from './fixtures'

// An agent's TUI draws its screen once and then only what changes (OpenCode on the alternate
// screen, Claude Code and Pi on the main one). The terminal host keeps only the last 2 MB of
// output for a replay, so after a while the replay holds only changes (here: a spinner), and a
// view that attaches later (another tab, another device) would draw an almost empty screen.
// The host makes the app repaint for each new view (a one-row resize nudge it tells no view
// about), so the second view gets the whole screen and the first one keeps it.
// The fakes' `tui <kb>` is e2e/fake_tui.py.

const whole = /TUI-TOP[\s\S]*SPUN[\s\S]*TUI-MIDDLE[\s\S]*TUI-BOTTOM/

async function secondView(page: Page, m: Minbox) {
  const [s] = await (await fetch(m.url + '/api/sessions')).json()
  const other = await page.context().newPage()
  await other.goto(`${m.url}/#s=${s.id}&tab=terminal`)
  await showTerminal(other)
  return other
}

for (const agent of ['claude', 'opencode'] as const) {
  test(`a second view of a ${agent} session that draws only changes gets its whole screen`, async ({ page, ocMinbox: m }) => {
    test.setTimeout(90_000)
    await page.goto(m.url)
    await createSession(page, m.dataDir, `repaint-${agent}`, agent)
    await expectTerminal(page, 'ready>')
    await typeInTerminal(page, 'tui 2600') // 2.6 MB of spinner: the start of the screen is cut off the replay
    await expect.poll(() => terminalText(page), { timeout: 40_000 }).toMatch(whole)

    const other = await secondView(page, m)
    await expect.poll(() => terminalText(other), { timeout: 15_000 }).toMatch(whole)
    // The first view saw the repaint too, at its own size: still the whole screen.
    await page.waitForTimeout(1000)
    expect(await terminalText(page)).toMatch(whole)
    await other.close()
  })
}

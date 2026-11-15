import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Reply help: when the agent spoke last, questions with options above the reply box; the answers go
// into the reply on Send. The server runs e2e/fake-suggest.py instead of claude
// (MINBOX_SUGGEST_COMMAND); it always asks: "How should it continue? (n)" (single: Go ahead / Wait
// for me), "What should it check?" (multi: Tests / Docs / Lint), "Anything else to tell it?" (free text).

async function seed(page: Page, dir: string, say = 'Finished the migration') {
  await createSession(page, dir, 'sg')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, `say ${say}`)
  await expectTerminal(page, /sent .*thr_/)
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('thread-subject')).toBeVisible()
}

/** The words of the thread's last message (what was delivered to the agent). */
async function lastWords(url: string): Promise<string> {
  const threads: { id: string }[] = await (await fetch(url + '/api/threads')).json()
  const th = await (await fetch(`${url}/api/threads/${threads[0].id}`)).json()
  const m = th.messages[th.messages.length - 1]
  return m.author === 'user' ? (m.words ?? m.body) : ''
}

const q = (page: Page, i: number) => page.locator(`[data-testid="reply-q"][data-index="${i}"]`)

test('questions render with options; single, multi and Other compose into the reply with the typed text', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(q(page, 0)).toContainText('How should it continue?')
  await expect(q(page, 0)).toHaveAttribute('data-kind', 'single')
  await expect(q(page, 0).getByRole('radiogroup')).toBeVisible()
  await expect(q(page, 0).getByRole('radio')).toHaveCount(3) // two options + Other
  await expect(q(page, 1).getByRole('checkbox')).toHaveCount(4) // three options + Other
  await expect(q(page, 2).getByTestId('reply-q-other-input')).toBeVisible() // free text only
  await expect(page.getByTestId('reply-send')).toBeDisabled()

  // Single choice: radio semantics; picking another replaces it.
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await expect(q(page, 0).getByRole('radio', { name: /Go ahead/ })).toHaveAttribute('aria-checked', 'true')
  await expect(q(page, 0)).toContainText('Continue with the plan') // the picked option's description
  await q(page, 0).getByRole('radio', { name: /Wait for me/ }).click()
  await expect(q(page, 0).getByRole('radio', { name: /Go ahead/ })).toHaveAttribute('aria-checked', 'false')
  // Keyboard: the arrow keys move and pick within the group.
  await q(page, 0).getByRole('radio', { name: /Wait for me/ }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect(q(page, 0).getByRole('radio', { name: /Go ahead/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('reply-qa-preview')).toContainText('Q: How should it continue?')
  await expect(page.getByTestId('reply-send')).toBeEnabled()

  // Multi choice plus Other text.
  await q(page, 1).getByRole('checkbox', { name: 'Tests' }).click()
  await q(page, 1).getByRole('checkbox', { name: 'Lint' }).click()
  await q(page, 1).getByTestId('reply-q-other').click()
  await q(page, 1).getByTestId('reply-q-other-input').fill('the migration script')
  await expect(page.getByTestId('reply-qa-preview')).toContainText('Q: What should it check? → A: Tests, Lint, the migration script')

  // Typing keeps the questions; Send composes answers, then the typed text.
  await page.getByTestId('reply-box').fill('Then open a PR.')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await page.getByTestId('reply-send').click()
  await expect(page.getByTestId('reply-qa')).toHaveCount(0)
  await expect(page.getByTestId('reply-box')).toHaveValue('')
  await expect
    .poll(() => lastWords(minbox.url))
    .toBe('Q: How should it continue? (0) → A: Go ahead\nQ: What should it check? → A: Tests, Lint, the migration script\n\nThen open a PR.')
  await expectTerminal(page, /Then open a PR/)
})

test('nothing answered: a plain send; answers only: the answers are the reply', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(page.getByTestId('reply-qa-preview')).toHaveCount(0)
  await page.getByTestId('reply-box').fill('Just a plain reply')
  await page.getByTestId('reply-send').click()
  await expect.poll(() => lastWords(minbox.url)).toBe('Just a plain reply')

  await typeInTerminal(page, 'say Next step done')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await q(page, 2).getByTestId('reply-q-other-input').fill('Nothing more')
  await page.getByTestId('reply-send').click()
  await expect.poll(() => lastWords(minbox.url)).toBe('Q: Anything else to tell it? → A: Nothing more')
})

test('collapse and dismiss', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await page.getByTestId('reply-qa-toggle').click()
  await expect(page.getByTestId('reply-qa-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('reply-q')).toHaveCount(0)
  await expect(page.getByTestId('reply-qa-toggle')).toContainText('1 answered')
  await expect(page.getByTestId('reply-qa-preview')).toBeVisible() // still says what goes with the reply
  await page.getByTestId('reply-qa-toggle').click()
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await page.getByTestId('reply-qa-dismiss').click()
  await expect(page.getByTestId('reply-qa')).toHaveCount(0)
  await expect(page.getByTestId('reply-send')).toBeDisabled() // dismissing drops the answers
})

test('the setting turns the questions off', async ({ page, minbox }) => {
  await fetch(minbox.url + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply_suggestions: false }) })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await page.waitForTimeout(800)
  await expect(page.getByTestId('reply-qa')).toHaveCount(0)
  await expect(page.getByTestId('reply-qa-loading')).toHaveCount(0)
  await expect(page.getByTestId('reply-box')).toBeVisible()
})

test('a denied command is offered as a one-tap !command', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir, 'Running `echo hi-from-denied` was denied. Should I continue?')
  const chip = page.getByTestId('reply-command')
  await expect(chip).toContainText('!echo hi-from-denied')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  // The pencil puts it in the box; answers are not added to a command.
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await page.getByTestId('reply-command-edit').click()
  await expect(page.getByTestId('reply-box')).toHaveValue('!echo hi-from-denied')
  await expect(page.getByTestId('reply-qa-preview')).toContainText('Not added to a command')
  await page.getByTestId('reply-box').fill('')
  // One tap runs it.
  await chip.click()
  const block = page.locator('[data-testid="message"][data-kind="command"]')
  await expect(block).toHaveCount(1)
  await expect(block.getByTestId('command-output')).toContainText('hi-from-denied')
})

test('phone: the questions sit above the compact composer and compose on Send', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'sg')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Finished the migration')
  await expectTerminal(page, /sent .*thr_/)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'home')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
  // The panel is above the composer row, and the row keeps its 44px controls.
  const panel = await page.getByTestId('reply-qa').boundingBox()
  const plus = await page.getByTestId('reply-actions').boundingBox()
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(plus!.y + 1)
  expect(Math.round(plus!.height)).toBe(44)
  const opt = await q(page, 0).getByRole('radio', { name: /Go ahead/ }).boundingBox()
  expect(opt!.height).toBeGreaterThanOrEqual(40)
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await page.getByTestId('reply-box').fill('ok')
  await page.getByTestId('reply-send').click()
  await expect.poll(() => lastWords(minbox.url)).toBe('Q: How should it continue? (0) → A: Go ahead\n\nok')
})

// Not a check: screenshots for docs (SCREENSHOTS=1 SCREENSHOT_DIR=docs/img/v2).
test('suggestion screenshots', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.goto(minbox.url)
  await seed(page, minbox.dataDir)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/sg-desktop.png` })
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(minbox.url + '/#')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/sg-phone.png` })
})

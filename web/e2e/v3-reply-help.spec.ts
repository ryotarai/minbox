import type { Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, expectTerminal, test, typeInTerminal, type Minbox } from './fixtures'
import { agentReply, api, say as sayTo, startAgent, taskNamed, type Agent } from './v3'

// v3 (ported from suggestions.spec.ts): the reply help above the reply box of an agent's stream, of a
// task's view (its latest agent message; also in the Columns view and on a phone).

// Reply help: when the agent spoke last, questions with options above the reply box; the answers go
// into the reply on Send. The server runs e2e/fake-suggest.py instead of claude
// (MINBOX_SUGGEST_COMMAND); it always asks: "How should it continue? (n)" (single: Go ahead / Wait
// for me), "What should it check?" (multi: Tests / Docs / Lint), "Anything else to tell it?" (free text).

/** An agent whose stream ends with its message `say` (after a first exchange, so the fake agent writes
 *  into its stream); with `denied`, its integration then reports that Bash command as denied and the
 *  agent says so in a second message. */
async function seed(page: Page, m: Minbox, say = 'Finished the migration', denied?: string) {
  const a = await startAgent(m, 'sg')
  await sayTo(m, a, 'hello there')
  await agentReply(m, a, /Sure — noted/)
  await page.goto(`${m.url}/#v=agent&s=${a.id}`)
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, `say ${say}`)
  await expectTerminal(page, /sent in thr_/)
  if (denied) {
    await typeInTerminal(page, `denied ${denied}`)
    await expectTerminal(page, /denied reported thr_/)
    await typeInTerminal(page, 'say I could not run it. Should I continue?')
    await expectTerminal(page, /denied reported thr_[\s\S]*sent in thr_/)
  }
  current = { m, a }
  // The help is drafted for the stream's last message: load it for that one.
  await page.reload()
  await expect(page.getByTestId('composer-text')).toBeVisible()
  return a
}

let current: { m: Minbox; a: Agent } | null = null

/** The words of the stream's last message of the person (what was delivered to the agent). */
async function lastWords(_url: string): Promise<string> {
  const s = await api(current!.m, 'GET', `/api/v3/sessions/${current!.a.id}/stream`)
  const u = [...s.messages].reverse().find((x: any) => x.author === 'user' && x.kind !== 'command')
  return u ? (u.words ?? u.body) : ''
}

async function streamThread(m: Minbox, a: Agent): Promise<string> {
  return (await api(m, 'GET', `/api/v3/sessions/${a.id}/stream`)).stream_thread_id
}

const q = (page: Page, i: number) => page.locator(`[data-testid="reply-q"][data-index="${i}"]`)

/** The gap between the bottom of the reply help box (`testid`: the questions, or the drafting row while
 *  they are still coming) and the top of the composer row that follows it ("to <agent> | + about a
 *  task"): the box must not sit on it. */
async function expectGapBelowHelp(scope: Page | ReturnType<Page['getByTestId']>, testid = 'reply-qa') {
  const gap = await scope.getByTestId(testid).evaluate((el) => {
    const next = el.nextElementSibling as HTMLElement | null
    return next ? next.getBoundingClientRect().top - el.getBoundingClientRect().bottom : null
  })
  expect(gap).not.toBeNull()
  expect(gap!).toBeGreaterThanOrEqual(6)
}

test('questions render with options; single, multi and Other compose into the reply with the typed text', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(q(page, 0)).toContainText('How should it continue?')
  await expect(q(page, 0)).toHaveAttribute('data-kind', 'single')
  await expect(q(page, 0).getByRole('radiogroup')).toBeVisible()
  await expect(q(page, 0).getByRole('radio')).toHaveCount(3) // two options + Other
  await expect(q(page, 1).getByRole('checkbox')).toHaveCount(4) // three options + Other
  await expect(q(page, 2).getByTestId('reply-q-other-input')).toBeVisible() // free text only
  await expect(page.getByTestId('composer-send')).toBeDisabled()

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
  await expect(page.getByTestId('reply-qa-toggle')).toContainText('1 answered')
  await expect(page.getByTestId('composer-send')).toBeEnabled()

  // Multi choice plus Other text.
  await q(page, 1).getByRole('checkbox', { name: 'Tests' }).click()
  await q(page, 1).getByRole('checkbox', { name: 'Lint' }).click()
  await q(page, 1).getByTestId('reply-q-other').click()
  await q(page, 1).getByTestId('reply-q-other-input').fill('the migration script')
  await expect(q(page, 1).getByRole('checkbox', { name: 'Tests' })).toHaveAttribute('aria-checked', 'true')
  await expect(q(page, 1).getByRole('checkbox', { name: 'Lint' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('reply-qa-toggle')).toContainText('2 answered')

  // Typing keeps the questions; Send composes answers, then the typed text.
  await page.getByTestId('composer-text').fill('Then open a PR.')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('composer-text')).toHaveValue('')
  await expect
    .poll(() => lastWords(minbox.url))
    .toBe('Q: How should it continue? (1) → A: Go ahead\nQ: What should it check? → A: Tests, Lint, the migration script\n\nThen open a PR.')
  await expectTerminal(page, /Then open a PR/)
})

test('nothing answered: a plain send; answers only: the answers are the reply', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await page.getByTestId('composer-text').fill('Just a plain reply')
  await page.getByTestId('composer-send').click()
  await expect.poll(() => lastWords(minbox.url)).toBe('Just a plain reply')

  await typeInTerminal(page, 'say Next step done')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await q(page, 2).getByTestId('reply-q-other-input').fill('Nothing more')
  await page.getByTestId('composer-send').click()
  await expect.poll(() => lastWords(minbox.url)).toBe('Q: Anything else to tell it? → A: Nothing more')
})

test('a new agent message keeps the picks and typed answers; only the untouched questions refresh', async ({ page, minbox }) => {
  writeFileSync(join(minbox.dataDir, 'suggest.agents'), '') // the multi question names the agent message count
  await page.goto(minbox.url)
  await seed(page, minbox)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(q(page, 1)).toContainText('What should it check? (2)')
  await q(page, 0).getByRole('radio', { name: /Wait for me/ }).click()
  await q(page, 1).getByRole('checkbox', { name: 'Docs' }).click()
  await q(page, 2).getByTestId('reply-q-other-input').fill('use the staging db')
  await page.getByTestId('composer-text').fill('My own words')

  await typeInTerminal(page, 'say Second update')
  // The answered questions stay as they were; the new suggestion's question is added.
  await expect(page.locator('[data-testid="reply-q"]', { hasText: 'What should it check? (3)' })).toHaveCount(1)
  await expect(page.getByTestId('reply-q')).toHaveCount(4)
  const old = page.locator('[data-testid="reply-q"]', { hasText: 'What should it check? (2)' })
  await expect(old.getByRole('checkbox', { name: 'Docs' })).toHaveAttribute('aria-checked', 'true')
  const cont = page.locator('[data-testid="reply-q"]', { hasText: 'How should it continue?' })
  await expect(cont.getByRole('radio', { name: /Wait for me/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('[data-testid="reply-q"]', { hasText: 'Anything else' }).getByTestId('reply-q-other-input')).toHaveValue('use the staging db')
  await expect(page.getByTestId('composer-text')).toHaveValue('My own words')
  await expect(page.getByTestId('reply-qa-toggle')).toContainText('3 answered')

  // A reload keeps them too.
  await page.reload()
  await expect(page.getByTestId('reply-q')).toHaveCount(4)
  await expect(page.getByTestId('reply-qa-toggle')).toContainText('3 answered')

  await page.getByTestId('composer-send').click()
  await expect
    .poll(() => lastWords(minbox.url))
    .toBe('Q: What should it check? (2) → A: Docs\nQ: How should it continue? (1) → A: Wait for me\nQ: Anything else to tell it? → A: use the staging db\n\nMy own words')
  // Sent: the answers are gone; the next message starts fresh.
  await typeInTerminal(page, 'say Third update')
  await expect(page.locator('[data-testid="reply-q"]', { hasText: 'What should it check? (4)' })).toHaveCount(1)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(page.getByTestId('reply-qa-toggle')).not.toContainText('answered')
})

test('untouched questions refresh on a new agent message', async ({ page, minbox }) => {
  writeFileSync(join(minbox.dataDir, 'suggest.agents'), '')
  await page.goto(minbox.url)
  await seed(page, minbox)
  await expect(q(page, 1)).toContainText('What should it check? (2)')
  await typeInTerminal(page, 'say Second update')
  await expect(q(page, 1)).toContainText('What should it check? (3)')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(page.getByText('What should it check? (2)')).toHaveCount(0)
})

test('while the questions are being drafted, the drafting row keeps the same gap above the composer row', async ({ page, minbox }) => {
  // Hold the questions back until released, so the drafting state stays on screen.
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  await page.route('**/suggestions', async (route) => {
    await held
    await route.continue().catch(() => {})
  })
  await page.goto(minbox.url)
  await seed(page, minbox)
  await expect(page.getByTestId('reply-qa-loading')).toBeVisible()
  await expectGapBelowHelp(page, 'reply-qa-loading')
  release()
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(page.getByTestId('reply-qa-loading')).toHaveCount(0)
  await expectGapBelowHelp(page)
})

test('collapse and dismiss', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await page.getByTestId('reply-qa-toggle').click()
  await expect(page.getByTestId('reply-qa-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expectGapBelowHelp(page)
  await expect(page.getByTestId('reply-q')).toHaveCount(0)
  await expect(page.getByTestId('reply-qa-toggle')).toContainText('1 answered')
  await page.getByTestId('reply-qa-toggle').click()
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await page.getByTestId('reply-qa-dismiss').click()
  await expect(page.getByTestId('reply-qa')).toHaveCount(0)
  await expect(page.getByTestId('composer-send')).toBeDisabled() // dismissing drops the answers
})

test('the setting turns the questions off', async ({ page, minbox }) => {
  await fetch(minbox.url + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reply_suggestions: false }) })
  await page.goto(minbox.url)
  await seed(page, minbox)
  await page.waitForTimeout(800)
  await expect(page.getByTestId('reply-qa')).toHaveCount(0)
  await expect(page.getByTestId('reply-qa-loading')).toHaveCount(0)
  await expect(page.getByTestId('composer-text')).toBeVisible()
  // Nor in a task's view.
  const t = await taskNamed(minbox, 'Typed in the terminal')
  await page.goto(`${minbox.url}/#s=${current!.a.id}&v=agent&k=${t.id}`)
  await expect(page.getByTestId('task-composer')).toBeVisible()
  await page.waitForTimeout(800)
  await expect(page.getByTestId('reply-qa')).toHaveCount(0)
})

test("a task's view: questions for the task's latest agent message; the answers go with the reply about the task and are kept by the task", async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox) // "Finished the migration" is in the task "Typed in the terminal"
  const t = await taskNamed(minbox, 'Typed in the terminal')
  await page.goto(`${minbox.url}/#s=${current!.a.id}&v=agent&k=${t.id}`)
  const box = page.getByTestId('task-composer')
  const tq = (i: number) => box.locator(`[data-testid="reply-q"][data-index="${i}"]`)
  await expect(box.getByTestId('reply-q')).toHaveCount(3)
  await expectGapBelowHelp(box)
  // Drafted from the task's messages: no message of the person is in it (the stream has one).
  await expect(tq(0)).toContainText('How should it continue? (0)')
  await tq(0).getByRole('radio', { name: /Go ahead/ }).click()
  await tq(2).getByTestId('reply-q-other-input').fill('keep the old table')
  await expect(box.getByTestId('reply-qa-toggle')).toContainText('2 answered')

  // The stream's help is its own (drafted from the stream; nothing answered there).
  await page.goto(`${minbox.url}/#v=agent&s=${current!.a.id}`)
  await expect(q(page, 0)).toContainText('How should it continue? (1)')
  await expect(page.getByTestId('reply-qa-toggle')).not.toContainText('answered')

  // Back in the task (and after a reload): the answers are still there.
  await page.goto(`${minbox.url}/#s=${current!.a.id}&v=agent&k=${t.id}`)
  await page.reload()
  await expect(box.getByTestId('reply-qa-toggle')).toContainText('2 answered')
  await expect(tq(2).getByTestId('reply-q-other-input')).toHaveValue('keep the old table')
  await box.getByTestId('composer-text').fill('Then ship it.')
  await box.getByTestId('composer-send').click()
  await expect(box.getByTestId('composer-text')).toHaveValue('')
  await expect.poll(() => lastWords(minbox.url)).toBe('Q: How should it continue? (0) → A: Go ahead\nQ: Anything else to tell it? → A: keep the old table\n\nThen ship it.')
  const s = await api(minbox, 'GET', `/api/v3/sessions/${current!.a.id}/stream`)
  const sent = [...s.messages].reverse().find((x: any) => x.author === 'user' && x.kind !== 'command')
  expect(sent.tasks.map((x: any) => x.task_id)).toEqual([t.id])
  // Sent: the answers are gone; the agent's next message about the task brings fresh questions.
  await agentReply(minbox, current!.a, /Sure — noted/)
  await expect(tq(0)).toContainText('How should it continue? (1)')
  await expect(box.getByTestId('reply-qa-toggle')).not.toContainText('answered')
})

test("minbox's request to place messages in tasks does not hide the questions for the agent's message before it", async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'sg')
  current = { m: minbox, a }
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await sayTo(minbox, a, 'IGNORE how is it going?')
  await agentReply(minbox, a, /Sure — noted/)
  await expect(page.getByTestId('stream-view').locator('[data-testid="v3-message"][data-kind="place"]').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(q(page, 0)).toContainText('How should it continue? (1)')
  const st = await streamThread(minbox, a)
  const sug = await (await fetch(`${minbox.url}/api/threads/${st}/suggestions`)).json()
  expect(sug.reason).toBeUndefined()
  expect(sug.questions).toHaveLength(3)
})

/** The agent's Tasks pane, unfolded. */
async function tasksPane(page: Page) {
  const pane = page.getByTestId('tasks-pane')
  await expect(pane).toBeVisible()
  if ((await pane.getAttribute('data-shown')) === 'false') await page.getByTestId('tasks-pane-toggle').first().click()
  await expect(pane).toHaveAttribute('data-shown', 'true')
  return pane
}

test("columns on an agent's page: each task column has the questions for its latest agent message", async ({ page, minbox }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(minbox.url)
  await seed(page, minbox)
  const t = await taskNamed(minbox, 'Typed in the terminal')
  const pane = await tasksPane(page)
  await pane.locator(`[data-testid="agent-task-check"][data-task="${t.id}"]`).check()
  const col = page.locator(`[data-testid="task-column"][data-task="${t.id}"]`)
  await expect(col.getByTestId('reply-q')).toHaveCount(3)
  await expect(col.locator('[data-testid="reply-q"][data-index="0"]')).toContainText('How should it continue? (0)')
})

test("an agent's page: a task opened from its Tasks pane has the questions for the task's latest agent message", async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  const t = await taskNamed(minbox, 'Typed in the terminal')
  const pane = await tasksPane(page)
  await pane.locator(`[data-testid="agent-task"][data-task="${t.id}"]`).click()
  const detail = page.getByTestId('agent-task-detail')
  await expect(detail.getByTestId('task-title')).toHaveText(/Typed in the terminal/)
  await expect(detail.getByTestId('reply-q')).toHaveCount(3)
  await expectGapBelowHelp(detail)
  await expect(detail.locator('[data-testid="reply-q"][data-index="0"]')).toContainText('How should it continue? (0)')
})

test("phone: a task's view has the questions above its reply box", async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox)
  const t = await taskNamed(minbox, 'Typed in the terminal')
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(`${minbox.url}/#s=${current!.a.id}&v=agent&k=${t.id}`)
  const box = page.getByTestId('task-composer')
  await expect(box.getByTestId('reply-q')).toHaveCount(3)
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
  const panel = await box.getByTestId('reply-qa').boundingBox()
  const text = await box.getByTestId('composer-text').boundingBox()
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(text!.y + 1)
  await expectGapBelowHelp(box)
  await box.locator('[data-testid="reply-q"][data-index="0"]').getByRole('radio', { name: /Wait for me/ }).click()
  await box.getByTestId('composer-send').click()
  await expect.poll(() => lastWords(minbox.url)).toBe('Q: How should it continue? (0) → A: Wait for me')
})

test('a denied command the agent reported is offered as a one-tap !command; running it clears it', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox, 'Trying the deploy.', 'echo hi-from-denied')
  const chip = page.getByTestId('reply-command')
  await expect(chip).toContainText('!echo hi-from-denied')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  // The pencil puts it in the box.
  await page.getByTestId('reply-command-edit').click()
  await expect(page.getByTestId('composer-text')).toHaveValue('!echo hi-from-denied')
  await page.getByTestId('composer-text').fill('')
  // One tap runs it.
  await chip.click()
  const block = page.locator('[data-testid="message"][data-kind="command"]')
  await expect(block).toHaveCount(1)
  await expect(block.getByTestId('command-output')).toContainText('hi-from-denied')
  // Run, it is no longer offered.
  const sug = await (await fetch(`${minbox.url}/api/threads/${await streamThread(minbox, current!.a)}/suggestions`)).json()
  expect(sug.command).toBeUndefined()
})

test('a message that only talks about denied commands offers no command', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox, 'Running `echo hi-from-denied` was denied. Please run `make lint` yourself.')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await expect(page.getByTestId('reply-command')).toHaveCount(0)
})

test('dismissing the help also drops the denied command', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox, 'Trying the deploy.', 'echo dismissed-one')
  await expect(page.getByTestId('reply-command')).toContainText('!echo dismissed-one')
  await page.getByTestId('reply-qa-dismiss').click()
  await expect(page.getByTestId('reply-command')).toHaveCount(0)
  const st = await streamThread(minbox, current!.a)
  await expect.poll(async () => (await (await fetch(`${minbox.url}/api/threads/${st}/suggestions`)).json()).command).toBeUndefined()
})

test('a !command sent from the box goes alone, without the answers', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await seed(page, minbox, 'Trying the deploy.', 'echo hi-from-denied')
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await page.getByTestId('reply-command-edit').click()
  await expect(page.getByTestId('composer-text')).toHaveValue('!echo hi-from-denied')
  await page.getByTestId('composer-send').click()
  const block = page.locator('[data-testid="message"][data-kind="command"]')
  await expect(block).toHaveCount(1)
  await expect(block.getByTestId('command-output')).toContainText('hi-from-denied')
  await expect(block).not.toContainText('How should it continue')
  const th = await (await fetch(`${minbox.url}/api/threads/${await streamThread(minbox, current!.a)}`)).json()
  expect(JSON.stringify(th.messages)).not.toContain('Q: How should it continue')
})

test('phone: the questions sit above the compact composer and compose on Send', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  const a = await seed(page, minbox)
  await page.setViewportSize({ width: 390, height: 800 })
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('reply-q')).toHaveCount(3)
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }))
  expect(m.scroll).toBeLessThanOrEqual(m.inner)
  // The panel is above the composer row, and the row keeps its 44px controls.
  const panel = await page.getByTestId('reply-qa').boundingBox()
  const box = await page.getByTestId('composer-text').boundingBox()
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(box!.y + 1)
  await expectGapBelowHelp(page)
  const opt = await q(page, 0).getByRole('radio', { name: /Go ahead/ }).boundingBox()
  expect(opt!.height).toBeGreaterThanOrEqual(40)
  await q(page, 0).getByRole('radio', { name: /Go ahead/ }).click()
  await page.getByTestId('composer-text').fill('ok')
  await page.getByTestId('composer-send').click()
  await expect.poll(() => lastWords(minbox.url)).toBe('Q: How should it continue? (1) → A: Go ahead\n\nok')
})


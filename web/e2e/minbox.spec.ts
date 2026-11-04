import { readFileSync } from 'node:fs'
import { createSession, expect, expectTerminal, terminalText, test, typeInTerminal } from './fixtures'

test('a session runs Claude Code in a terminal next to its inbox', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'demo')

  // The fake claude prints its arguments: a new conversation with our mod.
  await expectTerminal(page, /fake-claude new session=[0-9a-f-]{36}/)
  await expect(page.getByTestId('session-row').filter({ hasText: 'demo' })).toContainText('Waiting for you')
  await expect(page.getByTestId('inbox-pane')).toContainText('No messages yet')

  // Typing goes to the PTY.
  await typeInTerminal(page, 'hello there')
  await expectTerminal(page, 'echo: hello there')
})

test('a question from Claude is answered in the inbox and delivered back', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'ask')
  await expectTerminal(page, 'ready>')

  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)

  // The thread waits on the person, with two open questions.
  const row = page.getByTestId('thread-row').filter({ hasText: 'Pick a database' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('?2')
  await expect(page.getByTestId('inbox-pane')).toContainText('Waiting on you')
  await expect(page.getByTestId('badge-questions')).toHaveText('?2')
  await expect(page).toHaveTitle(/\(1\) minbox/)

  await row.click()
  const cards = page.getByTestId('question-card')
  await expect(cards).toHaveCount(2)
  await expect(cards.nth(0)).toContainText('Which database should we use?')
  await expect(cards.nth(0)).toContainText('Recommended')

  await cards.nth(0).getByTestId('accept-recommended').click()
  await expect(cards.nth(0).getByRole('radio', { name: /SQLite/ })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('answer-summary')).toContainText('1 of 2 answered')
  await cards.nth(1).getByTestId('question-text-input').fill('Keep backups daily')
  await expect(page.getByTestId('answer-summary')).toContainText('2 of 2 answered')
  await page.getByTestId('reply-box').fill('Thanks, go ahead.')
  await page.getByTestId('reply-send').click()

  // Claude (the fake) gets the composed reply in the terminal...
  await expectTerminal(page, '<<< inbox [Pick a database] Answered 2 questions.')
  const text = await terminalText(page)
  expect(text).toContain('Answer: SQLite (your recommendation)')
  expect(text).toContain('> Keep backups daily')
  // ...and the inbox shows it delivered, with the questions answered.
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
  await expect(cards.nth(0).getByTestId('question-state')).toHaveText('Answered')
  await expect(page).toHaveTitle('minbox')
})

test('the person can start a thread; it reaches Claude', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'compose')
  await expectTerminal(page, 'ready>')

  await expect(page.getByTestId('compose')).toHaveCount(0)
  await page.getByTestId('quick-body').fill('Please also update the README')
  await page.getByTestId('quick-send').click()
  await expect(page.getByTestId('thread-subject')).toHaveText('Please also update the README')
  await expectTerminal(page, '<<< inbox [Please also update the README] Please also update the README')
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')

  // Claude answers in the same thread: it shows up as new.
  await typeInTerminal(page, 'say Will do')
  await expect(page.getByTestId('message').filter({ hasText: 'Will do' })).toBeVisible()
})

test('pasting an image uploads it and types its path', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'paste')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('terminal').click()

  // Dispatch a paste event carrying a PNG (what Cmd+V does with an image on the clipboard).
  await page.evaluate(async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
    const dt = new DataTransfer()
    dt.items.add(new File([png], 'shot.png', { type: 'image/png' }))
    const target = document.querySelector('[data-testid="terminal"] textarea') ?? document.querySelector('[data-testid="terminal"]')!
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await expect(page.getByTestId('notice')).toContainText('Pasted image:')
  await page.keyboard.press('Enter')
  const joined = async () => (await terminalText(page)).replace(/\n/g, '')
  await expect.poll(joined, { timeout: 15_000 }).toMatch(/echo: .*scratch\/ses_[0-9a-f]+\/paste-.*\.png/)
  const path = (await joined()).match(/echo: (\S+?\.png)/)![1]!
  expect(readFileSync(path).subarray(1, 4).toString()).toBe('PNG')
})

test('stopping ends a session; Resume starts it again', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'stopper')
  await expectTerminal(page, 'ready>')

  const row = page.getByTestId('session-row').filter({ hasText: 'stopper' })
  await row.hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-stop').click()
  await expect(row).toContainText('Ended')
  await expect(page.getByTestId('resume')).toBeVisible()

  await page.getByTestId('resume').click()
  await expect(row).toContainText('Waiting for you')
  await expectTerminal(page, /fake-claude (new|resume) session=/)
})

test('Claude exiting by itself closes the session', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'quitter')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'exit')
  await expect(page.getByTestId('session-row').filter({ hasText: 'quitter' })).toContainText('Ended')
})

test('restarting the server keeps sessions running in the terminal host', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'survivor')
  await typeInTerminal(page, 'before restart')
  await expectTerminal(page, 'echo: before restart')

  await minbox.stop()
  await minbox.start()
  await page.reload()

  const row = page.getByTestId('session-row').filter({ hasText: 'survivor' })
  await expect(row).not.toContainText('Ended')
  // The same process: its scrollback is replayed, and it still answers.
  await expectTerminal(page, 'echo: before restart')
  await typeInTerminal(page, 'after restart')
  await expectTerminal(page, 'echo: after restart')
  expect(await terminalText(page)).not.toMatch(/fake-claude (new|resume).*\n[\s\S]*fake-claude (new|resume)/)
})

test('after an OS restart, open sessions resume by themselves; closed ones do not', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'open-one')
  await expectTerminal(page, 'ready>')
  await createSession(page, minbox.dataDir, 'closed-one')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'exit')
  await expect(page.getByTestId('session-row').filter({ hasText: 'closed-one' })).toContainText('Ended')

  // An OS restart: the server and the terminal host (with every PTY) are gone.
  await minbox.stop()
  minbox.killHost()
  await minbox.start()
  await page.reload()

  const open = page.getByTestId('session-row').filter({ hasText: 'open-one' })
  await expect(open).not.toContainText('Ended')
  await open.click()
  await expectTerminal(page, /fake-claude (new|resume) session=/)
  await expect(page.getByTestId('session-row').filter({ hasText: 'closed-one' })).toContainText('Ended')
})

test('a reply written while the session is stopped is delivered after Resume', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'later')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Done with the refactor')
  const row = page.getByTestId('thread-row').filter({ hasText: 'Note' })
  await expect(row).toBeVisible()

  const srow = page.getByTestId('session-row').filter({ hasText: 'later' })
  await srow.hover()
  await page.getByTestId('session-menu').click()
  await page.getByTestId('menu-stop').click()
  await expect(srow).toContainText('Ended')

  await row.click()
  await page.getByTestId('reply-box').fill('Great, now write tests')
  await page.getByTestId('reply-box').press('Meta+Enter')
  // The session is stopped: minbox asks where the reply goes. Keep it for after Resume.
  await page.getByTestId('where-keep').click()
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'undelivered')

  await page.getByTestId('resume').click()
  await expectTerminal(page, '<<< inbox [Note] Great, now write tests')
  await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered')
})

test('Cmd+V with an image on the clipboard types the uploaded path', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'clip')
  await expectTerminal(page, 'ready>')
  await page.getByTestId('terminal').click()
  // Put a real PNG on the system clipboard, then press Cmd+V.
  await page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = c.height = 4
    c.getContext('2d')!.fillRect(0, 0, 4, 4)
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'))
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
  await page.keyboard.press('Meta+V')
  await expect(page.getByTestId('notice')).toContainText('Pasted image:')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await terminalText(page)).replace(/\n/g, ''), { timeout: 15_000 }).toMatch(/echo: .*paste-.*\.png/)
})

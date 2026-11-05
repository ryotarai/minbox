import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'
import { terminalText } from './fixtures'

// Drives a REAL Claude Code (costs a little: Haiku) through minbox and its mod.
// Run with: MINBOX_REAL_CLAUDE=1 npx playwright test real-claude
const enabled = process.env.MINBOX_REAL_CLAUDE === '1'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test.describe('real Claude Code', () => {
  test.skip(!enabled, 'set MINBOX_REAL_CLAUDE=1')
  test.setTimeout(300_000)

  let proc: ChildProcess
  let dataDir: string
  const port = 4890
  const url = `http://127.0.0.1:${port}`
  let log = ''

  async function startServer() {
    proc = spawn(join(ROOT, 'bin/minbox'), ['start', '--foreground', '--addr', `127.0.0.1:${port}`, '--data-dir', dataDir, '--no-open', '--claude', process.env.MINBOX_CLAUDE ?? 'claude --model haiku'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout!.on('data', (d) => (log += d))
    proc.stderr!.on('data', (d) => (log += d))
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(url + '/api/sessions')).ok) return
      } catch {
        /* starting */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(log)
  }

  test.beforeAll(async () => {
    dataDir = mkdtempSync('/tmp/mbx-real-')
    await startServer()
  })

  test.afterAll(async () => {
    proc.kill('SIGTERM')
    spawn('pkill', ['-f', `host start --socket ${dataDir}`])
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function waitTerminal(page: Page, re: RegExp, timeout = 90_000) {
    await expect.poll(() => terminalText(page), { timeout, intervals: [1000] }).toMatch(re)
  }

  test('Claude asks in the inbox, the person answers, Claude gets the answer', async ({ page }) => {
    await page.goto(url)
    await page.getByTestId('new-session-cwd').fill(ROOT)
    await page.getByTestId('new-session-name').fill('real')
    await page.getByTestId('new-session-start').click()

    // The session connects (the mod's hello) once Claude Code is up.
    const row = page.getByTestId('session-status')
    // First time in a folder, Claude Code asks whether to trust it: the person answers in the terminal.
    await waitTerminal(page, /trust this folder|❯|>/, 60_000)
    if (/trust this folder/.test(await terminalText(page))) {
      await page.getByTestId('terminal').click()
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
    }
    await expect(row).toContainText(/Waiting for you|Working/, { timeout: 60_000 })
    await page.waitForTimeout(3000)
    console.log('--- terminal at start ---\n' + (await terminalText(page)))

    await page.getByTestId('terminal').click()
    await page.keyboard.type(
      'Use the minbox send_message tool now with subject "Color test" to ask me one :::question (pick one) "Which color should the button be?" with choices Red and Blue, recommending Blue. After sending it, end your turn without doing anything else.',
    )
    await page.keyboard.press('Enter')

    const thread = page.getByTestId('thread-row').filter({ hasText: 'Color test' })
    await expect(thread).toBeVisible({ timeout: 120_000 })
    await expect(thread).toContainText('?1')
    await thread.click()
    const card = page.getByTestId('question-card').first()
    await expect(card).toContainText('Which color should the button be?')

    // Wait for Claude's turn to end, then answer.
    await expect(row).toContainText('Waiting for you', { timeout: 120_000 })
    await card.getByRole('radio', { name: /Red/ }).click()
    await page.getByTestId('reply-box').fill('Then reply in the same thread with exactly: got it, red')
    await page.getByTestId('reply-send').click()

    await expect(page.getByTestId('delivery-line')).toHaveAttribute('data-delivery', 'delivered', { timeout: 60_000 })
    await waitTerminal(page, /minbox inbox: Color test/)
    // Claude answers in the thread.
    await expect(page.getByTestId('message').filter({ hasText: /got it, red/i })).toBeVisible({ timeout: 120_000 })
    console.log('--- terminal at end ---\n' + (await terminalText(page)))
    console.log('--- server log ---\n' + log)
  })

  test('after an OS restart the open session resumes its conversation', async ({ page }) => {
    // Everything goes away: the server, the terminal host and Claude Code.
    const exited = new Promise((r) => proc.once('exit', r))
    proc.kill('SIGTERM')
    await exited
    await new Promise((r) => spawn('pkill', ['-9', '-f', `host start --socket ${dataDir}`]).once('exit', r))
    await new Promise((r) => setTimeout(r, 500))
    await startServer()

    await page.goto(url)
    const row = page.getByTestId('session-status')
    await expect(row).toContainText(/Waiting for you|Working/, { timeout: 60_000 })
    // `claude --resume <id>` brings the earlier conversation back.
    await waitTerminal(page, /Color test/, 60_000)
    console.log('--- resumed terminal ---\n' + (await terminalText(page)))
  })
})

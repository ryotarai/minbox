import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, expectTerminal, test, typeInTerminal } from './fixtures'

// A second machine's host (here: another `minbox host --listen` on this one),
// added through the wizard, paired with `minbox pair accept`, then used.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BIN = join(ROOT, 'bin/minbox')

test('add a host: Direct, find it, pair with a code accepted there, then run a session on it', async ({ page, minbox }) => {
  const dir = mkdtempSync('/tmp/mbh-')
  const port = 4950 + Math.floor(Math.random() * 40)
  let host: ChildProcess | null = spawn(BIN, ['host', '--listen', `127.0.0.1:${port}`, '--data-dir', dir], { stdio: 'ignore' })
  try {
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}/version`).then((r) => r.status).catch(() => 0), { timeout: 10_000 }).toBe(200)

    await page.goto(minbox.url + '/#v=settings&ss=hosts')
    await expect(page.getByTestId('host-row')).toHaveCount(1)
    await expect(page.getByTestId('host-row')).toContainText('This machine')

    await page.getByTestId('host-add').click()
    await page.getByTestId('host-method-direct').click()
    await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('host-command')).toContainText('minbox host --listen 0.0.0.0:')
    await page.getByTestId('wizard-next').click()
    await page.getByTestId('host-url').fill(`http://127.0.0.1:${port}`)
    await expect(page.getByTestId('host-probe')).toContainText('Found · minbox host')
    await page.getByTestId('host-name').fill('devbox')
    await page.getByTestId('host-pair').click()

    const code = (await page.getByTestId('pair-code').textContent())!.trim()
    expect(code).toMatch(/^\d{3}-\d{3}$/)
    await expect(page.getByTestId('host-row').filter({ hasText: 'devbox' })).toContainText('Waiting for accept')
    // On "the other machine".
    expect(execFileSync(BIN, ['pair', 'list', '--data-dir', dir]).toString()).toContain(code)
    execFileSync(BIN, ['pair', 'accept', code, '--data-dir', dir])

    await expect(page.getByTestId('host-added')).toContainText('Added devbox', { timeout: 15_000 })
    const row = page.getByTestId('host-row').filter({ hasText: 'devbox' })
    await expect(row.getByTestId('host-status')).toContainText('Online')
    await expect(row.getByTestId('host-address')).toContainText(`http://127.0.0.1:${port} · paired`)

    await page.getByTestId('host-new-session').click()
    const devbox = page.getByTestId('new-session-host-option').filter({ hasText: 'devbox' })
    await expect(devbox).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('new-session-cwd').fill(dir)
    await page.getByTestId('new-session-name').fill('remote')
    await page.getByTestId('new-session-start').click()
    const srow = page.getByTestId('session-row').filter({ hasText: 'remote' })
    await expect(srow.getByTestId('host-tag')).toHaveText('devbox')
    await expectTerminal(page, 'ready>')

    // The mod's calls go through the host's relay.
    await typeInTerminal(page, 'ask')
    await expectTerminal(page, /sent question in thr_/)
    await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
    await page.getByTestId('question-card').first().getByTestId('accept-recommended').click()
    await page.getByTestId('reply-send').click()
    await expectTerminal(page, '<<< inbox [Pick a database]')

    // Removing the host ends its session and forgets this server there.
    await page.goto(minbox.url + '/#v=settings&ss=hosts')
    await page.getByTestId('host-row').filter({ hasText: 'devbox' }).getByTestId('host-menu').click()
    await page.getByTestId('host-remove').click()
    await page.getByTestId('host-remove-confirm').click()
    await expect(page.getByTestId('host-row')).toHaveCount(1)
    await page.getByTestId('settings-back').click()
    await expect(page.getByTestId('session-row').filter({ hasText: 'remote' })).toContainText('Ended')
  } finally {
    host?.kill('SIGTERM')
    host = null
    try {
      execFileSync('pkill', ['-f', `fake-claude.py.*`])
    } catch {
      /* none */
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

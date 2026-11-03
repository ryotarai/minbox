import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// `minbox start --listen 0.0.0.0:PORT`: another machine's browser (here: this
// one through its LAN address, over plain http, where browsers withhold
// WebCrypto) must pair; this machine's browser on 127.0.0.1 accepts it.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BIN = join(ROOT, 'bin/minbox')

function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return null
}

test('serve --listen: a browser on another address pairs over http, accepted on this machine', async ({ browser }) => {
  const ip = lanAddress()
  test.skip(!ip, 'no LAN address on this machine')
  const dir = mkdtempSync('/tmp/mbl-')
  const port = 4990 + Math.floor(Math.random() * 9)
  let proc: ChildProcess | null = spawn(BIN, ['start', '--foreground', '--listen', `0.0.0.0:${port}`, '--data-dir', dir, '--no-open', '--claude', 'sh'], { stdio: 'ignore' })
  try {
    await expect.poll(() => fetch(`http://127.0.0.1:${port}/api/sessions`).then((r) => r.status).catch(() => 0), { timeout: 10_000 }).toBe(200)
    // From the LAN address the API is closed.
    expect((await fetch(`http://${ip}:${port}/api/sessions`)).status).toBe(401)

    const other = await browser.newContext()
    const remote = await other.newPage()
    await remote.goto(`http://${ip}:${port}/`)
    await expect(remote.getByTestId('pair-screen')).toBeVisible()
    expect(await remote.evaluate(() => !!crypto.subtle)).toBe(false) // not a secure context
    await remote.getByTestId('device-name').fill('Laptop over LAN')
    await remote.getByTestId('device-pair').click()
    const code = (await remote.getByTestId('device-code').textContent())!.trim()

    const here = await (await browser.newContext()).newPage()
    await here.goto(`http://127.0.0.1:${port}/#v=settings&ss=devices`)
    const req = here.getByTestId('device-request').filter({ hasText: code })
    await expect(req).toContainText('Laptop over LAN')
    await req.getByTestId('device-accept').click()

    // The remote browser signs the challenge with its fallback key and gets in.
    await expect(remote.getByTestId('pair-screen')).toBeHidden({ timeout: 15_000 })
    await expect(remote.getByTestId('session-list')).toBeVisible()
    await other.close()
  } finally {
    proc?.kill('SIGTERM')
    proc = null
    spawn('pkill', ['-f', `host start --socket ${dir}`])
    rmSync(dir, { recursive: true, force: true })
  }
})

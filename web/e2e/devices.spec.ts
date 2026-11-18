import { execFileSync } from 'node:child_process'
import { BIN, createSession, createShellSession, expect, expectTerminal, runOnTerminal, showTerminal, test, TEST_DEVICE_NAME, typeInTerminal } from './fixtures'

// Every browser pairs its key first: one that reaches minbox over the network
// (here: requests carrying X-Forwarded-For, as through tailscale serve) and one
// on this machine's own 127.0.0.1 alike. A paired browser accepts it in
// Settings › Devices, or the person runs `minbox pair accept <code>` in a terminal.

test('a browser on this machine pairs too: it shows the code and the command, `minbox pair accept` in a terminal lets it in', async ({ browser, minbox }) => {
  // A fresh browser on 127.0.0.1 (no key of the tests' paired browser).
  const fresh = await browser.newContext()
  const page = await fresh.newPage()
  await page.goto(minbox.url)
  await expect(page.getByTestId('pair-screen')).toBeVisible()
  await expect(page.getByTestId('pair-screen')).toContainText('Every browser pairs with minbox once')
  // Nothing of the inbox answers it: not the API, not a raw request (an agent's curl, say).
  expect((await page.request.get(minbox.url + '/api/sessions')).status()).toBe(401)
  const raw = await page.evaluate(async () => {
    const r = await fetch('/api/threads/thr_x/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ words: 'yes' }) })
    return { status: r.status, body: await r.json() }
  })
  expect(raw).toEqual({ status: 401, body: { code: 'unpaired', error: 'this browser is not paired with this minbox' } })
  const curl = await fetch(minbox.url + '/api/threads/thr_x/reply', { method: 'POST', headers: { 'content-type': 'application/json', cookie: '' }, body: JSON.stringify({ words: 'yes' }) })
  expect(curl.status).toBe(401)

  await page.getByTestId('device-name').fill('Chrome here')
  await page.getByTestId('device-pair').click()
  const code = (await page.getByTestId('device-code').textContent())!.trim()
  const fingerprint = (await page.getByTestId('device-fingerprint').textContent())!.trim()
  expect(fingerprint).toMatch(/^ecdsa-p256 SHA256:[A-Za-z0-9+/]{43}$/)
  // Both ways to accept it: the command (with Copy), and a paired browser.
  await expect(page.getByTestId('pair-command')).toHaveText(`minbox pair accept ${code}`)
  await expect(page.getByTestId('pair-command-copy')).toBeVisible()
  await expect(page.getByTestId('pair-by-device')).toContainText('Settings › Devices')

  // `minbox pair list` shows it; a reload keeps its code.
  expect(execFileSync(BIN, ['pair', 'list', '--data-dir', minbox.dataDir]).toString()).toContain(`${code}  browser  Chrome here  ${fingerprint}`)
  await page.reload()
  await page.getByTestId('device-pair').click()
  await expect(page.getByTestId('device-code')).toHaveText(code)

  // Not from a shell tool (no terminal): refused, exit 2.
  let refused: { status?: number; stderr?: Buffer } = {}
  try {
    execFileSync(BIN, ['pair', 'accept', code, '--data-dir', minbox.dataDir], { input: 'y\n', stdio: 'pipe' })
  } catch (e) {
    refused = e as typeof refused
  }
  expect(refused.status).toBe(2)
  expect(String(refused.stderr)).toContain('stdin is not a terminal')
  await expect(page.getByTestId('pair-screen')).toBeVisible()

  // The person, in a terminal: it shows the browser and its key, asks, pairs.
  const out = runOnTerminal(['pair', 'accept', code, '--data-dir', minbox.dataDir], 'y\n')
  expect(out).toContain('Chrome here')
  expect(out).toContain(fingerprint)
  expect(out).toContain('127.0.0.1 (this machine)')
  expect(out).toContain('paired the browser Chrome here')

  // The page goes on by itself into the app, and the API answers it.
  await expect(page.getByTestId('pair-screen')).toBeHidden({ timeout: 15_000 })
  expect((await page.request.get(minbox.url + '/api/sessions')).status()).toBe(200)
  await fresh.close()
})

test('a remote browser pairs with a code accepted in Settings › Devices, and Revoke sends it back', async ({ page, browser, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'home')
  await expectTerminal(page, 'ready>')

  const remote = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '100.64.0.7' }, viewport: { width: 390, height: 844 } })
  const phone = await remote.newPage()
  await phone.goto(minbox.url)
  await expect(phone.getByTestId('pair-screen')).toBeVisible()
  // Nothing of the inbox is reachable yet.
  expect((await phone.request.get(minbox.url + '/api/sessions')).status()).toBe(401)
  await phone.getByTestId('device-name').fill('Test phone')
  await phone.getByTestId('device-pair').click()
  const code = (await phone.getByTestId('device-code').textContent())!.trim()

  // On this machine: a banner, then Accept.
  await expect(page.getByTestId('pair-request-banner')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('pair-request-banner').getByRole('button', { name: 'Review' }).click()
  const req = page.getByTestId('device-request')
  await expect(req).toContainText(code)
  await expect(req).toContainText('Test phone')
  await req.getByTestId('device-accept').click()
  await expect(page.getByTestId('device-row').filter({ hasText: 'Test phone' })).toBeVisible()

  // The phone signs in by itself and sees the sessions.
  await expect(phone.getByTestId('phone-tabs')).toBeVisible({ timeout: 15_000 })
  await phone.getByTestId('tab-agents').click()
  await expect(phone.getByTestId('agent-row').filter({ hasText: 'home' })).toBeVisible()

  // Revoked: its next request finds it unpaired.
  await page.getByTestId('device-row').filter({ hasText: 'Test phone' }).getByTestId('device-revoke').click()
  await expect(page.getByTestId('device-row').filter({ hasText: 'Test phone' })).toHaveCount(0)
  await expect(page.getByTestId('device-row').filter({ hasText: TEST_DEVICE_NAME })).toContainText('This browser')
  await phone.reload()
  await expect(phone.getByTestId('pair-screen')).toBeVisible({ timeout: 10_000 })
  await remote.close()
})

test('a paired remote browser signs in again by itself after the server forgets its cookie (a restart)', async ({ page, browser, minbox }) => {
  await page.goto(minbox.url)
  await createShellSession(page, minbox, 'home')

  const remote = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '100.64.0.8' }, viewport: { width: 1280, height: 800 } })
  const phone = await remote.newPage()
  type W = { __socks: WebSocket[]; WebSocket: typeof WebSocket; __minboxReconnect?: () => void }
  // Keep the sockets so the test can drop them, as a restart does.
  await phone.addInitScript(() => {
    const w = window as unknown as W
    w.__socks = []
    const Real = w.WebSocket
    w.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        w.__socks.push(this)
      }
    } as typeof WebSocket
  })
  await phone.goto(minbox.url)
  await phone.getByTestId('device-name').fill('Restart phone')
  await phone.getByTestId('device-pair').click()
  await expect(page.getByTestId('pair-request-banner')).toBeVisible({ timeout: 10_000 })
  await page.getByTestId('pair-request-banner').getByRole('button', { name: 'Review' }).click()
  await page.getByTestId('device-request').getByTestId('device-accept').click()
  await phone.getByTestId('agent-row').filter({ hasText: 'home' }).click({ timeout: 15_000 })
  await showTerminal(phone)
  await expect(phone.getByTestId('terminal-session-name')).toHaveText('home', { timeout: 15_000 })
  await typeInTerminal(phone, 'echo before-$((1+1))')
  await expectTerminal(phone, 'before-2')

  let signins = 0
  phone.on('request', (r) => {
    if (r.url().endsWith('/api/devices/auth') && r.method() === 'POST') signins++
  })
  let eventsOk = 0
  phone.on('response', (r) => {
    if (r.url().endsWith('/api/events') && r.status() === 200) eventsOk++
  })
  // The server forgets the cookie (simulated: the browser's is gone). Then both streams drop.
  await remote.clearCookies()
  await phone.evaluate(() => {
    const w = window as unknown as W
    w.__socks.forEach((s) => s.close())
    w.__minboxReconnect?.()
  })

  // No reload: the page signs in again, the event stream and the terminal come back.
  await expect.poll(() => signins, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  await expect.poll(() => eventsOk, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
  await expect.poll(() => phone.evaluate(() => (window as unknown as W).__socks.some((s, i) => i > 0 && s.readyState === 1)), { timeout: 20_000 }).toBe(true)
  await typeInTerminal(phone, 'echo after-$((3+4))')
  await expectTerminal(phone, 'after-7')
  await remote.close()
})

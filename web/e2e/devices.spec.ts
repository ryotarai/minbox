import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// A browser that reaches minbox over the network (here: requests carrying
// X-Forwarded-For, as through tailscale serve) pairs its key first; a browser
// on this machine accepts it in Settings › Devices.

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
  await expect(phone.getByTestId('session-row').filter({ hasText: 'home' })).toBeVisible({ timeout: 15_000 })

  // Revoked: its next request finds it unpaired.
  await page.getByTestId('device-row').filter({ hasText: 'Test phone' }).getByTestId('device-revoke').click()
  await expect(page.getByTestId('device-row')).toHaveCount(0)
  await phone.reload()
  await expect(phone.getByTestId('pair-screen')).toBeVisible({ timeout: 10_000 })
  await remote.close()
})

test('a paired remote browser signs in again by itself after the server forgets its cookie (a restart)', async ({ page, browser, minbox }) => {
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'home', 'shell')

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
  await phone.getByTestId('session-row').filter({ hasText: 'home' }).click({ timeout: 15_000 })
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

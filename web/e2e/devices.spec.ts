import { createSession, expect, expectTerminal, test } from './fixtures'

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

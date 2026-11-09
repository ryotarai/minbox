import { expect, test } from './fixtures'

// Receiving status under a Slack app destination, and "Check receiving now". The status and the
// check answer are stubbed at the API (Playwright route interception): the server's own cycle is
// covered by the Go tests with a fake Slack, and no real Slack is ever contacted.
test('Slack receiving status and Check receiving now', async ({ page, minbox }) => {
  const token = 'xox' + 'b-1-fakefakefake'
  const created = await (
    await fetch(minbox.url + '/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'slack_app', name: 'My Slack', config: { bot_token: token, channel: 'U0ME' } }),
    })
  ).json()
  const iso = (secs: number) => new Date(Date.now() + secs * 1000).toISOString()
  const status = {
    receiving: true,
    last_poll_at: iso(-120),
    last_poll_ok: false,
    last_poll_error: 'Receiving from Slack: The app lacks the im:history scope: add it and reinstall the app',
    summary: '',
    next_poll_at: iso(40),
    paused_until: null,
    interval_seconds: 180,
    configured_seconds: 60,
    slowed: true,
    dm_known: false,
    delivered: 3,
    last_delivered_at: iso(-600),
    watched_threads: 2,
    problems: ['The app lacks the im:history scope: add it under OAuth & Permissions → Bot Token Scopes and reinstall the app'],
    missing_scopes: ['im:history'],
  }
  let checks = 0
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const body = await res.json()
    body.destinations = body.destinations.map((d: any) => (d.id === created.id ? { ...d, receive_status: status } : d))
    await route.fulfill({ response: res, json: body })
  })
  await page.route(`**/api/notifications/${created.id}/check`, async (route) => {
    checks++
    await new Promise((r) => setTimeout(r, 400))
    Object.assign(status, { last_poll_at: iso(0), last_poll_ok: true, last_poll_error: '', slowed: false, interval_seconds: 60, dm_known: true, problems: [], missing_scopes: [] })
    await route.fulfill({ json: { ran: true, busy: false, summary: 'fetched 200 messages, 0 new', status } })
  })

  await page.goto(`${minbox.url}/#v=settings&ss=notifications`)
  await expect(page.getByTestId('notif-list')).toBeVisible()
  const box = page.getByTestId('slack-receive-status')
  await expect(box).toBeVisible()
  await expect(box.getByTestId('slack-receive-last-poll')).toContainText('2 min ago')
  await expect(box.getByTestId('slack-receive-last-poll')).toContainText('im:history')
  await expect(box.getByTestId('slack-receive-next-poll')).toContainText('slowed')
  await expect(box.getByTestId('slack-receive-dm')).toContainText('press Send test first')
  await expect(box.getByTestId('slack-receive-delivered')).toContainText('3, last 10 min ago · watching 2 threads')
  await expect(box.getByTestId('slack-receive-problems')).toContainText('im:history')

  await box.getByTestId('slack-check-now').click()
  await expect(box.getByTestId('slack-check-now')).toBeDisabled()
  await expect(box.getByTestId('slack-check-result')).toHaveText('fetched 200 messages, 0 new')
  expect(checks).toBe(1)
  await expect(box.getByTestId('slack-receive-problems')).toHaveCount(0)
  await expect(box.getByTestId('slack-receive-dm')).toHaveText(/known$/)
  await expect(box.getByTestId('slack-check-now')).toBeEnabled()
})

// Regression: Settings > Notifications went black (a React crash) when a receiving Slack app had no
// problems, because the server sent "problems": null and the page read .length. Also old stored
// destinations (no config), null lists and a null status must render, not crash.
test('Notifications renders with problems null, old destinations and null lists', async ({ page, minbox }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  const token = 'xox' + 'b-1-fakefakefake'
  const created = await (
    await fetch(minbox.url + '/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'slack_app', name: 'Healthy Slack', config: { bot_token: token, channel: 'U0ME' } }),
    })
  ).json()
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const res = await route.fetch()
    const body = await res.json()
    const status = { receiving: true, last_poll_at: null, last_poll_ok: null, last_poll_error: null, summary: '', next_poll_at: null, paused_until: null, interval_seconds: 60, configured_seconds: 60, slowed: false, dm_known: true, delivered: 0, last_delivered_at: null, watched_threads: 0, problems: null, missing_scopes: null }
    const old = { enabled: true, created_at: new Date().toISOString(), last_ok_at: null, last_error: '', last_error_at: null }
    body.destinations = [
      ...body.destinations.map((d: any) => (d.id === created.id ? { ...d, receive_status: status } : d)),
      { ...old, id: 'old1', type: 'slack_app', name: 'Old one', config: null, receive_status: null },
      { ...old, id: 'old2', type: 'gone_type', name: 'Unknown type', config: {} },
    ]
    body.types = body.types.map((t: any) => ({ ...t, fields: t.fields.map((f: any) => ({ ...f, options: f.options ?? null })) }))
    await route.fulfill({ response: res, json: body })
  })
  await page.goto(`${minbox.url}/#v=settings&ss=notifications`)
  await expect(page.getByTestId('notif-list')).toBeVisible()
  await expect(page.getByTestId('notif-row')).toHaveCount(3)
  await expect(page.getByTestId('slack-receive-status')).toHaveCount(1)
  await expect(page.getByTestId('settings-crash')).toHaveCount(0)
  await page.getByTestId('notif-edit').first().click()
  await expect(page.getByTestId('notif-form-name')).toBeVisible()
  expect(errors).toEqual([])
})

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, test, typeInTerminal } from './fixtures'

// Notifications: a Slack incoming webhook gets every new message from Claude. The "Slack" here
// is a local HTTP server on 127.0.0.1 only; no real Slack is ever contacted.

type Hit = { path: string; json: any }

async function fakeSlack(): Promise<{ url: string; hits: Hit[]; status: { code: number }; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const status = { code: 200 }
  const srv: Server = createServer((req, res) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => {
      hits.push({ path: req.url ?? '', json: JSON.parse(b || '{}') })
      res.statusCode = status.code
      res.end(status.code === 200 ? 'ok' : 'no_service')
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, hits, status, close: () => new Promise((r) => srv.close(() => r())) }
}

const texts = (h: Hit) => (h.json.blocks as any[]).filter((b) => b.text).map((b) => b.text.text as string).join('\n')

async function openNotifications(page: Page, base: string) {
  await page.goto(`${base}/#v=settings&ss=notifications`)
  await expect(page.getByTestId('notif-list')).toBeVisible()
}

async function addSlack(page: Page, name: string, hook: string, opts: { full?: boolean; events?: string } = {}) {
  await page.getByTestId('notif-add').click()
  await expect(page.getByTestId('notif-type')).toContainText('Slack')
  await page.getByTestId('notif-form-name').fill(name)
  await page.getByTestId('notif-field-webhook_url').fill(hook)
  if (opts.full === false) await page.getByTestId('notif-field-include_body').getByRole('switch').click()
  if (opts.events) await page.getByTestId('notif-field-events').selectOption(opts.events)
  await page.getByTestId('notif-save').click()
  await expect(page.getByTestId('notif-row').filter({ hasText: name })).toBeVisible()
}

test('add a Slack destination, send a test, and get a full agent message', async ({ page, minbox }) => {
  const slack = await fakeSlack()
  try {
    await openNotifications(page, minbox.url)
    await expect(page.getByTestId('notif-empty')).toBeVisible()

    // The public URL makes the "Open thread" link.
    await page.getByTestId('notif-public-url').fill('https://box.example.ts.net/')
    await page.getByTestId('notif-public-url-save').click()
    await expect.poll(async () => (await (await fetch(minbox.url + '/api/settings')).json()).public_url).toBe('https://box.example.ts.net/')

    const hook = `${slack.url}/services/T000/B000/SECRETtail`
    await addSlack(page, 'Team channel', hook)
    const row = page.getByTestId('notif-row').filter({ hasText: 'Team channel' })
    // The URL is shown masked, never in full.
    await expect(row.getByTestId('notif-target')).toHaveText(`${slack.url}/…tail`)
    await expect(page.locator('body')).not.toContainText('SECRETtail')
    await expect(row.getByTestId('notif-status')).toHaveAttribute('data-state', 'never')
    const api = await (await fetch(minbox.url + '/api/notifications')).json()
    expect(JSON.stringify(api)).not.toContain('SECRETtail')

    // Send test.
    await row.getByTestId('notif-test').click()
    await expect(row.getByTestId('notif-test-result')).toHaveText('Test sent')
    await expect.poll(() => slack.hits.length).toBe(1)
    expect(slack.hits[0].path).toBe('/services/T000/B000/SECRETtail')
    expect(texts(slack.hits[0])).toContain('test notification')
    await expect(row.getByTestId('notif-status')).toHaveAttribute('data-state', 'ok')

    // A failing webhook shows its error.
    slack.status.code = 404
    await row.getByTestId('notif-test').click()
    await expect(row.getByTestId('notif-test-result')).toContainText('404')
    await expect(row.getByTestId('notif-status')).toHaveAttribute('data-state', 'failed')
    slack.status.code = 200

    // Edit without typing the URL keeps it: switch to title only, then back to full.
    await row.getByTestId('notif-edit').click()
    await expect(page.getByTestId('notif-field-webhook_url')).toHaveAttribute('placeholder', `Kept: ${slack.url}/…tail`)
    await page.getByTestId('notif-form-name').fill('Team')
    await page.getByTestId('notif-save').click()
    await expect(page.getByTestId('notif-row').filter({ hasText: 'Team' }).getByTestId('notif-name')).toHaveText('Team')

    // An agent message arrives with its full body.
    const dir = join(minbox.dataDir, 'work', 'proj')
    mkdirSync(dir, { recursive: true })
    await page.goto(minbox.url)
    await createSession(page, dir, 'alpha')
    await expectTerminal(page, 'ready>')
    const before = slack.hits.length
    await typeInTerminal(page, 'say The **full** body: a < b & c, see [docs](https://x.io/d) end-of-message')
    await expectTerminal(page, /sent .*thr_/)
    await expect.poll(() => slack.hits.length).toBe(before + 1)
    const t = texts(slack.hits[before])
    expect(t).toContain('*proj / alpha*')
    expect(t).toContain('The *full* body: a &lt; b &amp; c, see <https://x.io/d|docs> end-of-message')
    const last = slack.hits[before].json.blocks.at(-1)
    expect(last.type).toBe('actions')
    expect(last.elements[0].url).toMatch(/^https:\/\/box\.example\.ts\.net\/#s=ses_\w+&t=thr_\w+$/)

    // Disabled: nothing is sent.
    await page.goto(`${minbox.url}/#v=settings&ss=notifications`)
    await page.getByTestId('notif-row').getByRole('switch', { name: 'Enable Team' }).click()
    await expect.poll(async () => (await (await fetch(minbox.url + '/api/notifications')).json()).destinations[0].enabled).toBe(false)
    const n = slack.hits.length
    await page.goto(minbox.url)
    await typeInTerminal(page, 'say while disabled')
    await expectTerminal(page, 'while disabled')
    await page.waitForTimeout(800)
    expect(slack.hits.length).toBe(n)

    // Delete.
    await page.goto(`${minbox.url}/#v=settings&ss=notifications`)
    await page.getByTestId('notif-delete').click()
    await page.getByTestId('notif-delete-confirm').click()
    await expect(page.getByTestId('notif-empty')).toBeVisible()
  } finally {
    await slack.close()
  }
})

test('"only messages that need your answer" and title-only destinations', async ({ page, minbox }) => {
  const askOnly = await fakeSlack()
  const titleOnly = await fakeSlack()
  try {
    await openNotifications(page, minbox.url)
    await addSlack(page, 'Questions', `${askOnly.url}/a/b/c1234`, { events: 'action' })
    await addSlack(page, 'Titles', `${titleOnly.url}/a/b/d5678`, { full: false })
    const dir = join(minbox.dataDir, 'work', 'proj')
    mkdirSync(dir, { recursive: true })
    await page.goto(minbox.url)
    await createSession(page, dir, 'beta')
    await expectTerminal(page, 'ready>')
    await typeInTerminal(page, 'say plain note with secret details')
    await expectTerminal(page, /sent .*thr_/)
    await expect.poll(() => titleOnly.hits.length).toBe(1)
    expect(texts(titleOnly.hits[0])).not.toContain('secret details')
    expect(askOnly.hits.length).toBe(0)
    await typeInTerminal(page, 'ask')
    await expectTerminal(page, /sent question in thr_/)
    await expect.poll(() => askOnly.hits.length).toBe(1)
    expect(JSON.stringify(askOnly.hits[0].json)).toContain('needs your answer')
  } finally {
    await askOnly.close()
    await titleOnly.close()
  }
})

test('notifications settings on a phone', async ({ page, minbox }) => {
  const slack = await fakeSlack()
  try {
    await page.setViewportSize({ width: 390, height: 800 })
    await openNotifications(page, minbox.url)
    await addSlack(page, 'Phone test', `${slack.url}/p/q/r0000`)
    const row = page.getByTestId('notif-row')
    await expect(row.getByTestId('notif-test')).toBeVisible()
    const box = await row.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    await row.getByTestId('notif-test').click()
    await expect(row.getByTestId('notif-test-result')).toHaveText('Test sent')
    await expect(page.getByTestId('notif-public-url')).toBeVisible()
  } finally {
    await slack.close()
  }
})

async function addSlackApp(page: Page, name: string, token: string, channel: string, opts: { threads?: boolean } = {}) {
  await page.getByTestId('notif-add').click()
  await page.getByTestId('notif-type').selectOption('slack_app')
  await page.getByTestId('notif-form-name').fill(name)
  await page.getByTestId('notif-field-bot_token').fill(token)
  await page.getByTestId('notif-field-channel').fill(channel)
  if (opts.threads === false) await page.getByTestId('notif-field-thread_replies').getByRole('switch').click()
  await page.getByTestId('notif-save').click()
  await expect(page.getByTestId('notif-row').filter({ hasText: name })).toBeVisible()
}

test('Slack app: help text, token masked, test reports the bot, messages group in one Slack thread, failures show', async ({ page, minbox }) => {
  const api = minbox.slackApi
  await openNotifications(page, minbox.url)
  await page.getByTestId('notif-add').click()
  await expect(page.getByTestId('notif-type')).toContainText('Slack app (bot token)')
  await expect(page.getByTestId('notif-help')).toHaveCount(0) // the webhook type has none
  await page.getByTestId('notif-type').selectOption('slack_app')
  await expect(page.getByTestId('notif-help')).toBeVisible()
  await expect(page.getByTestId('notif-help')).toContainText('api.slack.com/apps')
  await expect(page.getByTestId('notif-help')).toContainText('chat:write')
  await expect(page.getByTestId('notif-help')).toContainText('/invite')
  await page.keyboard.press('Escape')

  await addSlackApp(page, 'Alerts bot', 'xoxb-111-SECRETvalue-wxyz', '#alerts')
  const row = page.getByTestId('notif-row').filter({ hasText: 'Alerts bot' })
  await expect(row.getByTestId('notif-target')).toHaveText('#alerts · xoxb-…wxyz')
  await expect(page.locator('body')).not.toContainText('SECRETvalue')
  expect(JSON.stringify(await (await fetch(minbox.url + '/api/notifications')).json())).not.toContain('SECRETvalue')

  // Send test: auth.test first, then a top-level message.
  await row.getByTestId('notif-test').click()
  await expect(row.getByTestId('notif-test-result')).toHaveText('Test sent. Connected to Acme as minbot')
  expect(api.calls.map((c) => c.method)).toEqual(['auth.test', 'chat.postMessage'])
  expect(api.calls[0].auth).toBe('Bearer xoxb-111-SECRETvalue-wxyz')
  expect(api.posts[0].json.thread_ts).toBeUndefined()

  // Two agent messages of one thread: parent, then a reply to it.
  const dir = join(minbox.dataDir, 'work', 'proj')
  mkdirSync(dir, { recursive: true })
  await page.goto(minbox.url)
  await createSession(page, dir, 'gamma')
  await expectTerminal(page, 'ready>')
  const before = api.posts.length
  await typeInTerminal(page, 'say first note')
  await expectTerminal(page, /sent .*thr_/)
  await expect.poll(() => api.posts.length).toBe(before + 1)
  await typeInTerminal(page, 'say second note')
  await expect.poll(() => api.posts.length).toBe(before + 2)
  const [parent, reply] = api.posts.slice(before)
  expect(parent.json.thread_ts).toBeUndefined()
  expect(parent.json.channel).toBe('#alerts')
  expect(JSON.stringify(parent.json.blocks)).toContain('first note')
  expect(reply.json.thread_ts).toBe('1700000000.000002') // the test message was ts ...001
  expect(reply.json.channel).toBe('C0123ABCD')
  expect(JSON.stringify(reply.json.blocks)).toContain('second note')

  // A failing token shows in the list.
  api.postError = 'invalid_auth'
  await typeInTerminal(page, 'say third note')
  await page.goto(`${minbox.url}/#v=settings&ss=notifications`)
  const status = page.getByTestId('notif-row').filter({ hasText: 'Alerts bot' }).getByTestId('notif-status')
  await expect(status).toHaveAttribute('data-state', 'failed')
  await expect(status).toContainText('Failed')
  await expect(status).toContainText('The token is invalid')
})

// Not a check: screenshots for docs/ui-v2-threads.md (SCREENSHOTS=1 SCREENSHOT_DIR=docs/img/v2).
test('notification screenshots', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  const slack = await fakeSlack()
  try {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.setViewportSize({ width: 1300, height: 800 })
    await openNotifications(page, minbox.url)
    await page.getByTestId('notif-public-url').fill('https://my-mac.tail1234.ts.net')
    await page.getByTestId('notif-public-url-save').click()
    await addSlack(page, 'Team #dev', `${slack.url}/services/T0123/B0456/abcdWXYZ`)
    await addSlack(page, 'On-call (questions only)', `${slack.url}/services/T0123/B0789/qrstJKLM`, { events: 'action' })
    await page.getByTestId('notif-row').first().getByTestId('notif-test').click()
    await expect(page.getByTestId('notif-test-result')).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/notif-01-desktop-settings.png` })
    await page.getByTestId('notif-add').click()
    await page.getByTestId('notif-form-name').fill('Ops channel')
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/notif-02-desktop-add.png` })
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 390, height: 800 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/notif-03-phone-settings.png`, fullPage: false })
  } finally {
    await slack.close()
  }
})

// Not a check: screenshots of the Slack app destination (SCREENSHOTS=1 SCREENSHOT_DIR=docs/img/v2).
test('slack app screenshots', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1300, height: 900 })
  await openNotifications(page, minbox.url)
  await addSlackApp(page, 'Alerts bot', 'xoxb-1234567890-abcdefWXYZ', '#alerts')
  await page.getByTestId('notif-row').first().getByTestId('notif-test').click()
  await expect(page.getByTestId('notif-test-result')).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/notif-app-01-settings.png` })
  await page.getByTestId('notif-add').click()
  await page.getByTestId('notif-type').selectOption('slack_app')
  await page.getByTestId('notif-form-name').fill('On-call bot')
  await page.getByTestId('notif-field-channel').fill('C0123ABCD')
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/notif-app-02-add.png` })
}) 

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { createSession, expect, expectTerminal, selectSession, test, typeInTerminal } from './fixtures'

// "Start new thread from here": a thread started from one message of another, with the source's id
// handed to the new agent (the handoff, put in front of its first message) and the source told.

const SHOTS = process.env.FORK_SHOTS // a folder: dark-theme screenshots for review

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name + '.png') })
}

async function sourceThread(page: Page, minbox: { url: string; dataDir: string }, text: string) {
  if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto(minbox.url)
  await createSession(page, minbox.dataDir, 'alpha')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, `say ${text}`)
  await expectTerminal(page, 'sent in thr_')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-thread-id', /^thr_/)
  return (await page.getByTestId('thread-view').getAttribute('data-thread-id'))!
}

test('desktop: fork into the same session; the agent gets the handoff; both threads show the link', async ({ page, minbox }) => {
  const src = await sourceThread(page, minbox, 'Plan: add a cache layer then migrate the API')
  const msg = page.getByTestId('message').first()
  await msg.hover()
  await msg.getByTestId('message-fork').click()
  const dlg = page.getByTestId('fork-dialog')
  await expect(dlg).toBeVisible()
  // The preview is the real composition: source id, quote, tool name.
  const preview = page.getByTestId('fork-preview')
  await expect(preview).toContainText(`source_thread_id: ${src}`)
  await expect(preview).toContainText('add a cache layer')
  await expect(preview).toContainText('mcp__minbox__read_thread')
  await expect(page.getByTestId('fork-dest-same')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('fork-title')).toHaveValue('Plan: add a cache layer then migrate the API')
  await page.getByTestId('fork-instruction').fill('Start with the cache only')
  await expect(preview).toContainText('Start with the cache only')
  await shot(page, 'fork-dialog-desktop')
  await page.getByTestId('fork-start').click()

  // The new thread: breadcrumb + collapsible handoff context; its agent got the block.
  await expect(page.getByTestId('fork-breadcrumb')).toContainText('Forked from')
  await expect(page.getByTestId('fork-breadcrumb')).toContainText('message #1')
  const child = await page.getByTestId('thread-view').getAttribute('data-thread-id')
  expect(child).not.toBe(src)
  await expect(page.getByTestId('handoff-card')).toBeVisible()
  await expect(page.getByTestId('handoff-text')).toBeHidden()
  await page.getByTestId('handoff-card').locator('summary').click()
  await expect(page.getByTestId('handoff-text')).toContainText(`source_thread_id: ${src}`)
  await expect(page.getByTestId('message').first()).toContainText('Start with the cache only')
  await shot(page, 'fork-breadcrumb-desktop')
  await expectTerminal(page, 'CARRIED CONTEXT, not an instruction')
  await expectTerminal(page, `source_thread_id: ${src}`)
  await expectTerminal(page, 'Start with the cache only')

  // The list marks both.
  await page.getByTestId('thread-row').first().waitFor()
  await expect(page.getByTestId('fork-icon')).toHaveCount(1)
  await expect(page.getByTestId('fork-count')).toHaveText('1')

  // The source: a derived marker under the message, with a jump link; the message count is unchanged.
  await page.getByTestId('fork-breadcrumb-link').click()
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-thread-id', src)
  const marker = page.getByTestId('fork-marker')
  await expect(marker).toContainText('Started thread')
  await expect(marker).toContainText('same session')
  await expect(page.getByTestId('message')).toHaveCount(1)
  await shot(page, 'fork-marker-desktop')
  await marker.getByTestId('fork-marker-link').click()
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-thread-id', child!)
})

test('desktop: fork into another session; the source agent hears of it once, with its next message', async ({ page, minbox }) => {
  mkdirSync(join(minbox.dataDir, 'other'))
  const src = await sourceThread(page, minbox, 'Which cache should we use?')
  await createSession(page, join(minbox.dataDir, 'other'), 'beta')
  await expectTerminal(page, 'ready>')
  await selectSession(page, 'alpha')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-thread-id', src)

  const msg = page.getByTestId('message').first()
  await msg.hover()
  await msg.getByTestId('message-more').click()
  await page.getByTestId('message-fork-item').click()
  await page.getByTestId('fork-dest-other').click()
  const betaValue = await page.getByTestId('fork-session').locator('option').filter({ hasText: 'beta' }).getAttribute('value')
  await page.getByTestId('fork-session').selectOption(betaValue!)
  await expect(page.getByTestId('fork-warning').first()).toBeVisible()
  await page.getByTestId('fork-title').fill('Cache options')
  await page.getByTestId('fork-start').click()

  // We are now in beta's new thread: its terminal got the handoff.
  await expect(page.getByTestId('fork-breadcrumb')).toBeVisible()
  await expectTerminal(page, `source_thread_id: ${src}`)

  // Back in alpha: marker, then the next message to alpha carries the notice (no turn of its own).
  await selectSession(page, 'alpha')
  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('fork-marker')).toContainText('Cache options')
  await expect(page.getByTestId('fork-marker')).toContainText('beta')
  await page.getByTestId('reply-box').fill('Thanks, carry on')
  await page.getByTestId('reply-send').click()
  await expectTerminal(page, '<minbox_thread_forks')
  await expectTerminal(page, 'Cache options')
  await expectTerminal(page, 'Thanks, carry on')
  // Told once: the next reply has no notice.
  await page.getByTestId('reply-box').fill('One more thing')
  await page.getByTestId('reply-send').click()
  await expectTerminal(page, 'One more thing')
  const text = await page.evaluate(() => {
    const term = (window as any).__minboxTerminal
    const buf = term.buffer.active
    let s = ''
    for (let i = 0; i < buf.length; i++) s += (buf.getLine(i)?.translateToString(true) ?? '') + '\n'
    return s
  })
  expect(text.split('<minbox_thread_forks').length - 1).toBe(1)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  test('phone: the message menu starts a fork; the header says where it came from', async ({ page, minbox }) => {
    if (SHOTS) await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto(minbox.url)
    await createSession(page, minbox.dataDir, 'alpha')
    await expect(page.getByTestId('phone')).toBeVisible()
    // Seed the thread through the API (the phone's terminal view is not needed).
    const sessions = await (await page.request.get(minbox.url + '/api/sessions')).json()
    const sess = sessions[0]
    const r = await page.request.post(`${minbox.url}/api/sessions/${sess.id}/threads`, { data: { subject: 'Seeded', body: 'Seeded request about the cache layer' } })
    expect(r.ok()).toBe(true)
    const thr = (await r.json()).id as string
    await page.goto(`${minbox.url}/#s=${sess.id}&t=${thr}`)
    await expect(page.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
    await page.getByTestId('message-more').first().tap()
    await page.getByTestId('message-fork-item').tap()
    await expect(page.getByTestId('fork-preview')).toContainText(`source_thread_id: ${thr}`)
    await shot(page, 'fork-dialog-phone')
    await page.getByTestId('fork-start').tap()
    await expect(page.getByTestId('phone-fork-crumb')).toContainText('Forked from Seeded')
    await expect(page.getByTestId('fork-breadcrumb')).toContainText('message #1')
    await shot(page, 'fork-breadcrumb-phone')
    await page.getByTestId('fork-breadcrumb-link').tap()
    await expect(page.getByTestId('fork-marker')).toBeVisible()
    await shot(page, 'fork-marker-phone')
  })
})

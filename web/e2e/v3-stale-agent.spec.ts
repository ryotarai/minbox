// A running agent that loaded an older minbox mod or older instructions than a restart would give it
// (internal/server/stale.go): a banner under its header with Restart, a mark on its sidebar row,
// Dismiss for this version. The change here is the person's prompt setting (prompt_extra): it is
// part of the instructions an agent gets at its start, so a running agent has the older text until
// it restarts, the same as after a minbox upgrade with new prompts or a new mod.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { api, startAgent } from './v3'

/** STALE_SHOTS=<dir> saves screenshots of the banner there. */
async function snap(page: Page, name: string) {
  const dir = process.env.STALE_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

const staleOf = async (m: Parameters<typeof api>[0], id: string) => (await api(m, 'GET', '/api/sessions')).find((x: any) => x.id === id)?.stale ?? false

test('a stale agent shows the banner and a sidebar mark; Restart resumes it and clears them', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await page.goto(minbox.url)
  await page.getByTestId('agent-row').filter({ hasText: 'api' }).click()
  const stream = page.getByTestId('stream-view')
  await expect(stream.getByTestId('agent-name')).toHaveText('api')
  const banner = page.getByTestId('stale-agent-banner')
  const mark = page.getByTestId('agent-row').filter({ hasText: 'api' }).getByTestId('agent-stale-mark')
  // A freshly started agent is not stale.
  await page.waitForTimeout(500)
  await expect(banner).toHaveCount(0)
  await expect(mark).toHaveCount(0)

  // The instructions change: the running agent has the older ones (pushed live, no reload).
  await api(minbox, 'PUT', '/api/settings', { prompt_extra: 'answer in haiku' })
  await expect(banner).toBeVisible()
  await expect(banner).toHaveAttribute('data-reasons', 'prompt')
  await expect(banner).toContainText('Restart it to pick up the changes')
  await expect(banner).not.toContainText(/session/i)
  await expect(mark).toBeVisible()
  await snap(page, 'desktop')

  // Restart: the agent resumes its conversation (the same restart as the menu's) and is current.
  await page.getByTestId('stale-agent-restart').click()
  await expect.poll(() => minbox.log, { timeout: 20_000 }).toMatch(new RegExp(`modconn: spawn session=${a.id} resume=true`))
  await expect(banner).toHaveCount(0, { timeout: 20_000 })
  await expect(mark).toHaveCount(0)
  await expect.poll(async () => (await api(minbox, 'GET', '/api/sessions')).find((x: any) => x.id === a.id)?.status, { timeout: 20_000 }).toBe('idle')
  expect(await staleOf(minbox, a.id)).toBe(false)
  await snap(page, 'desktop-after-restart')
})

test('Dismiss hides the notice for this version of the agent, across reloads', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  await api(minbox, 'PUT', '/api/settings', { prompt_extra: 'be brief' })
  await page.goto(minbox.url)
  await page.getByTestId('agent-row').filter({ hasText: 'api' }).click()
  const banner = page.getByTestId('stale-agent-banner')
  const mark = page.getByTestId('agent-row').filter({ hasText: 'api' }).getByTestId('agent-stale-mark')
  await expect(banner).toBeVisible()
  await page.getByTestId('stale-agent-dismiss').click()
  await expect(banner).toHaveCount(0)
  await expect(mark).toHaveCount(0)
  // Still dismissed after a reload: the agent runs the same version.
  await page.reload()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(banner).toHaveCount(0)
  expect(await staleOf(minbox, a.id)).toBe(true)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })
  test('phone: the banner fits and Restart works', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'api')
    await api(minbox, 'PUT', '/api/settings', { prompt_extra: 'be brief' })
    await page.goto(minbox.url)
    await page.getByTestId('tab-agents').tap()
    await expect(page.getByTestId('agent-row').filter({ hasText: 'api' }).getByTestId('agent-stale-mark')).toBeVisible()
    await page.getByTestId('agent-row').filter({ hasText: 'api' }).tap()
    const banner = page.getByTestId('stale-agent-banner')
    await expect(banner).toBeVisible()
    const box = await banner.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await snap(page, 'phone')
    await page.getByTestId('stale-agent-restart').tap()
    await expect.poll(() => minbox.log, { timeout: 20_000 }).toMatch(new RegExp(`modconn: spawn session=${a.id} resume=true`))
    await expect(banner).toHaveCount(0, { timeout: 20_000 })
  })
})

// An agent that seems to wait for input in its terminal (internal/server/stuck.go): no hello since its
// start (Claude Code's trust-folder prompt here, FAKE_TRUST_PROMPT), a message it does not take
// ("deaf"), or a turn that died on an API error (a model that does not exist, FAKE_TURN_ERROR). A
// banner under its header with the terminal's matching line and Open terminal, a mark on its sidebar
// row, and the same banner above a task of it picked in All agents. The thresholds are 3 s here
// (stuckMinbox). STUCK_SHOTS=<dir> saves screenshots.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, typeInTerminal, type Minbox } from './fixtures'
import { api, say, startAgent, type Agent } from './v3'

async function snap(page: Page, name: string) {
  const dir = process.env.STUCK_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

/** Starts an agent with variables for the fake claude, without waiting for it to be idle. */
async function createAgent(m: Minbox, name: string, env: Record<string, string>): Promise<Agent> {
  const cwd = join(m.dataDir, 'proj')
  mkdirSync(cwd, { recursive: true })
  const s = await api(m, 'POST', '/api/sessions', { cwd, name, env })
  return { id: s.id, name, project_id: s.project_id }
}

const sessionOf = async (m: Minbox, id: string) => (await api(m, 'GET', '/api/sessions')).find((x: any) => x.id === id)

test('an agent held at a startup prompt: banner with the prompt, Open terminal shows the terminal, answering it clears the banner', async ({ page, stuckMinbox: m }) => {
  const a = await createAgent(m, 'api', { FAKE_TRUST_PROMPT: '1' })
  await page.goto(m.url)
  await page.getByTestId('agent-row').filter({ hasText: 'api' }).click()
  await expect(page.getByTestId('stream-view').getByTestId('agent-name')).toHaveText('api')
  const banner = page.getByTestId('stuck-agent-banner')
  const mark = page.getByTestId('agent-row').filter({ hasText: 'api' }).getByTestId('agent-stuck-mark')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner).toHaveAttribute('data-kind', 'startup')
  await expect(banner).toContainText('This agent seems to be waiting for input in its terminal.')
  await expect(page.getByTestId('stuck-agent-hint')).toHaveText('Do you trust the files in this folder?', { timeout: 15_000 })
  await expect(banner).not.toContainText(/session/i)
  await expect(mark).toBeVisible()
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await snap(page, 'desktop-startup')

  // Open terminal shows the agent's terminal pane (hidden until now), with the prompt in it.
  await page.getByTestId('stuck-agent-open-terminal').click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'true')
  await snap(page, 'desktop-terminal-open')

  // Answered: the fake says hello, and the banner and the mark go.
  await typeInTerminal(page, '1')
  await expect(banner).toHaveCount(0, { timeout: 15_000 })
  await expect(mark).toHaveCount(0)
  expect((await sessionOf(m, a.id)).stuck ?? '').toBe('')
})

test('a message the agent does not take shows the banner until it takes it; Dismiss hides this occurrence', async ({ page, stuckMinbox: m }) => {
  const a = await startAgent(m, 'api')
  await page.goto(m.url)
  await page.getByTestId('agent-row').filter({ hasText: 'api' }).click()
  await typeInTerminal(page, 'deaf')
  await say(m, a, 'are you there?')
  const banner = page.getByTestId('stuck-agent-banner')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner).toHaveAttribute('data-kind', 'message')
  await page.getByTestId('stuck-agent-dismiss').click()
  await expect(banner).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(banner).toHaveCount(0)
  expect((await sessionOf(m, a.id)).stuck).toBe('message')
  // It takes the message: no longer stuck.
  await typeInTerminal(page, 'listen')
  await expect.poll(async () => (await sessionOf(m, a.id)).stuck ?? '', { timeout: 15_000 }).toBe('')
})

test('a turn that dies on an API error: banner with the error, in the agent page and above its task in All agents; a reply clears it', async ({ page, stuckMinbox: m }) => {
  await page.setViewportSize({ width: 1400, height: 860 })
  const a = await createAgent(m, 'api', { FAKE_TURN_ERROR: '1' })
  await expect.poll(async () => (await sessionOf(m, a.id))?.status, { timeout: 15_000 }).toBe('idle')
  const task = await api(m, 'POST', '/api/v3/tasks', { project_id: a.project_id, title: 'Fix the login page', session_id: a.id })
  await page.goto(m.url)
  await page.getByTestId('agent-row').filter({ hasText: 'api' }).click()
  await say(m, a, 'please fix the login page', [task.id])
  const banner = page.getByTestId('stuck-agent-banner')
  await expect(banner).toBeVisible({ timeout: 15_000 })
  await expect(banner).toHaveAttribute('data-kind', 'error')
  await expect(banner).toContainText("This agent hit an error and didn't reply. Check its terminal.")
  await expect(page.getByTestId('stuck-agent-hint')).toContainText('API Error: 404', { timeout: 15_000 })
  await expect(page.getByTestId('stuck-agent-hint')).toContainText('not_found_error')
  await snap(page, 'desktop-error')

  // All agents, the task picked: the same banner, naming the agent; Open terminal opens its page on the terminal.
  await page.goto(m.url + `/#v=alltasks&k=${task.id}`)
  const named = page.getByTestId('all-agents-view').getByTestId('stuck-agent-banner')
  await expect(named).toBeVisible()
  await expect(named).toContainText("api hit an error and didn't reply.")
  await snap(page, 'desktop-all-agents')
  await named.getByTestId('stuck-agent-open-terminal').click()
  await expect(page.getByTestId('stream-view')).toHaveAttribute('data-session', a.id)
  await expect(page.getByTestId('terminal')).toBeVisible()

  // The model is fixed: the next message gets a reply, and the banner goes.
  await typeInTerminal(page, 'fail off')
  await say(m, a, 'try again please')
  await expect(page.getByTestId('stuck-agent-banner')).toHaveCount(0, { timeout: 15_000 })
  expect((await sessionOf(m, a.id)).stuck ?? '').toBe('')
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('phone: the banner shows in the agent stream; Open terminal goes to its terminal', async ({ page, stuckMinbox: m }) => {
    const a = await createAgent(m, 'api', { FAKE_TRUST_PROMPT: '1' })
    await page.goto(m.url + `/#v=agent&s=${a.id}`)
    const banner = page.getByTestId('stuck-agent-banner')
    await expect(banner).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('stuck-agent-hint')).toHaveText('Do you trust the files in this folder?', { timeout: 15_000 })
    const width = await page.evaluate(() => document.documentElement.scrollWidth)
    expect(width).toBeLessThanOrEqual(390)
    await snap(page, 'phone-startup')
    await page.getByTestId('stuck-agent-open-terminal').click()
    await expect(page.getByTestId('terminal')).toBeVisible()
    await snap(page, 'phone-terminal')
    await typeInTerminal(page, '1')
    await expect.poll(async () => (await sessionOf(m, a.id)).stuck ?? '', { timeout: 15_000 }).toBe('')
  })
})

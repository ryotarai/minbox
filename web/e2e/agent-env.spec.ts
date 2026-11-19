// The New agent dialog's Advanced section: environment variables (KEY=value lines) for the new
// agent. Closed by default; bad and reserved keys are shown inline and block the start; the agent's
// process gets them; the values are not shown again (the agent's menu names the keys only).
// AGENT_ENV_SHOTS=<dir> also saves screenshots of the open section (desktop and phone).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, expectTerminal, test } from './fixtures'
import { api, startAgent } from './v3'

const SECRET = 'fake-e2e-secret-0123'
const shots = process.env.AGENT_ENV_SHOTS

const envLines = (dump: string) => ['# fake values for the test', `E2E_TOKEN=${SECRET}`, 'E2E_EQ=a=b=c', 'E2E_EMPTY=', '', `E2E_ENV_DUMP=${dump}`].join('\n')

function readDump(path: string): Record<string, string> | null {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

test('New agent › Advanced: environment variables reach the agent, values are not shown again', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await page.getByTestId('first-agent').click()
  const dlg = page.getByRole('dialog', { name: 'New agent' })
  await expect(dlg).toBeVisible()
  await page.getByTestId('new-session-cwd').fill(minbox.dataDir)
  await page.getByTestId('new-session-name').fill('envy')

  // Closed by default.
  const adv = page.getByTestId('new-session-advanced')
  await expect(adv).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('new-session-env')).toHaveCount(0)
  await adv.click()
  await expect(adv).toHaveAttribute('aria-expanded', 'true')
  const env = page.getByTestId('new-session-env')

  // minbox's own variables and bad names: inline errors, no start.
  await env.fill('MINBOX_TOKEN=x\nTERM=dumb\n1BAD=x\nno equals sign')
  const errs = page.getByTestId('new-session-env-error')
  await expect(errs).toContainText('Line 1: MINBOX_TOKEN is set by minbox itself')
  await expect(errs).toContainText('Line 2: TERM is set by minbox itself')
  await expect(errs).toContainText('Line 3: “1BAD” is not a variable name')
  await expect(errs).toContainText('Line 4: expected KEY=value')
  await expect(page.getByTestId('new-session-start')).toBeDisabled()

  const dump = join(minbox.dataDir, 'env-dump.json')
  await env.fill(envLines(dump))
  await expect(errs).toHaveCount(0)
  await expect(page.getByTestId('new-session-start')).toBeEnabled()
  if (shots) {
    await page.locator('#new-session-env-help').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(shots, 'new-agent-advanced-desktop.png') })
  }

  // Closing the section keeps them (and says how many).
  await adv.click()
  await expect(page.getByTestId('new-session-env-count')).toHaveText('· 4 environment variables')
  await adv.click()
  await expect(env).toHaveValue(envLines(dump))

  await page.getByTestId('new-session-start').click()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await expectTerminal(page, 'ready>')
  await expect.poll(() => readDump(dump), { timeout: 15_000 }).toEqual({ E2E_TOKEN: SECRET, E2E_EQ: 'a=b=c', E2E_EMPTY: '', E2E_ENV_DUMP: dump })

  // The browser's API names the keys only; the agent's menu shows them.
  const list = JSON.stringify(await api(minbox, 'GET', '/api/sessions'))
  expect(list).not.toContain(SECRET)
  expect(list).toContain('E2E_TOKEN')
  await page.getByTestId('agent-menu').click()
  await expect(page.getByTestId('agent-info-env')).toHaveText('E2E_EMPTY, E2E_ENV_DUMP, E2E_EQ, E2E_TOKEN')
  await expect(page.getByText(SECRET)).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('phone: the New agent sheet has the Advanced section, and its variables reach the agent', async ({ page, minbox }) => {
    const a = await startAgent(minbox, 'first')
    await page.goto(minbox.url)
    await page.getByTestId('tab-agents').tap()
    await page.getByTestId('project-new-agent').first().tap()
    const dlg = page.getByRole('dialog', { name: 'New agent' })
    await expect(dlg).toBeVisible()
    await page.getByTestId('new-session-name').fill('phone-envy')
    await page.getByTestId('new-session-advanced').tap()
    const dump = join(minbox.dataDir, 'env-dump-phone.json')
    await page.getByTestId('new-session-env').fill(envLines(dump))
    await expect(page.getByTestId('new-session-env-error')).toHaveCount(0)
    await page.getByTestId('new-session-env').scrollIntoViewIfNeeded()
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    expect(noHScroll).toBe(true)
    if (shots) await page.screenshot({ path: join(shots, 'new-agent-advanced-phone.png') })
    await page.getByTestId('new-session-start').tap()
    await expect.poll(() => readDump(dump), { timeout: 15_000 }).toEqual({ E2E_TOKEN: SECRET, E2E_EQ: 'a=b=c', E2E_EMPTY: '', E2E_ENV_DUMP: dump })
    // The first agent (no variables) did not get them.
    expect((await api(minbox, 'GET', '/api/sessions')).find((x: any) => x.id === a.id)?.env_keys).toBeUndefined()
  })
})

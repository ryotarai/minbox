// Editing an agent's environment variables after it started (the ⋯ menu's "Environment variables…",
// PATCH /api/sessions/{id}/env): the current keys show masked, Replace value / Remove per row, Add as
// KEY=value lines. Save keeps the agent running and marks it stale ("env"); Save and restart resumes it
// with the new set (fake-claude dumps its E2E_* variables to E2E_ENV_DUMP at each start). The values
// never come back to the browser.
// AGENT_ENV_SHOTS=<dir> also saves screenshots of the editor (desktop and phone).
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { api, startAgent } from './v3'

const SECRET = 'fake-e2e-secret-0123'
const NEW_SECRET = 'fake-e2e-new-secret-4567'
const shots = process.env.AGENT_ENV_SHOTS

function readDump(path: string): Record<string, string> | null {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  } catch {
    return null // being written
  }
}

test('edit an agent’s environment variables: Save marks it stale, Save and restart applies them', async ({ page, minbox }) => {
  const dump = join(minbox.dataDir, 'env-edit-dump.json')
  const a = await startAgent(minbox, 'envy', 'proj', { env: { E2E_TOKEN: SECRET, E2E_GONE: 'bye', E2E_ENV_DUMP: dump } })
  await expect.poll(() => readDump(dump), { timeout: 15_000 }).toEqual({ E2E_TOKEN: SECRET, E2E_GONE: 'bye', E2E_ENV_DUMP: dump })

  await page.goto(minbox.url)
  await page.getByTestId('agent-row').filter({ hasText: 'envy' }).click()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await page.getByTestId('agent-menu').click()
  await expect(page.getByTestId('agent-info-env')).toContainText('E2E_ENV_DUMP, E2E_GONE, E2E_TOKEN')
  await page.getByTestId('menu-edit-env').click()
  const dlg = page.getByRole('dialog', { name: 'Environment variables' })
  await expect(dlg).toBeVisible()
  await expect(dlg).not.toContainText(/session/i)
  const rows = dlg.getByTestId('agent-env-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(2)).toContainText('E2E_TOKEN')
  await expect(rows.nth(2)).toContainText('••••')
  await expect(page.getByText(SECRET)).toHaveCount(0)
  await expect(dlg.getByTestId('agent-env-save')).toBeDisabled()

  // Replace E2E_TOKEN, remove E2E_GONE, add two; a reserved key in Add is refused inline.
  const token = rows.filter({ hasText: 'E2E_TOKEN' })
  await token.getByTestId('agent-env-replace').click()
  await token.getByTestId('agent-env-replace-input').fill(NEW_SECRET)
  await rows.filter({ hasText: 'E2E_GONE' }).getByTestId('agent-env-remove').click()
  await expect(rows.filter({ hasText: 'E2E_GONE' })).toContainText('removed on save')
  const add = dlg.getByTestId('agent-env-add')
  await add.fill('MINBOX_TOKEN=x')
  await expect(dlg.getByTestId('agent-env-error')).toContainText('MINBOX_TOKEN is set by minbox itself')
  await expect(dlg.getByTestId('agent-env-save')).toBeDisabled()
  await add.fill('E2E_ADDED=a=b\nE2E_EMPTY=')
  await expect(dlg.getByTestId('agent-env-error')).toHaveCount(0)
  await expect(dlg.getByTestId('agent-env-when')).toContainText('take effect when the agent restarts')
  if (shots) await page.screenshot({ path: join(shots, 'edit-env-desktop.png') })

  // Save only: stored, the running agent keeps its variables and is marked stale for "env".
  await dlg.getByTestId('agent-env-save').click()
  await expect(dlg).toHaveCount(0)
  const listed = async () => (await api(minbox, 'GET', '/api/sessions')).find((x: any) => x.id === a.id)
  await expect.poll(async () => (await listed())?.env_keys).toEqual(['E2E_ADDED', 'E2E_EMPTY', 'E2E_ENV_DUMP', 'E2E_TOKEN'])
  const raw = JSON.stringify(await api(minbox, 'GET', '/api/sessions'))
  expect(raw).not.toContain(SECRET)
  expect(raw).not.toContain(NEW_SECRET)
  const banner = page.getByTestId('stale-agent-banner')
  await expect(banner).toBeVisible()
  await expect(banner).toHaveAttribute('data-reasons', 'env')
  await expect(banner).toContainText('Restart it to apply the new environment variables')
  expect(readDump(dump)).toEqual({ E2E_TOKEN: SECRET, E2E_GONE: 'bye', E2E_ENV_DUMP: dump })
  if (shots) await page.screenshot({ path: join(shots, 'edit-env-stale-banner-desktop.png') })

  // Remove a key and Save and restart: the agent resumes with the new set and is current.
  rmSync(dump)
  await page.getByTestId('agent-menu').click()
  await page.getByTestId('agent-info-env-edit').click()
  await expect(dlg).toBeVisible()
  await dlg.getByTestId('agent-env-row').filter({ hasText: 'E2E_EMPTY' }).getByTestId('agent-env-remove').click()
  await dlg.getByTestId('agent-env-save-restart').click()
  await expect(dlg).toHaveCount(0)
  await expect.poll(() => minbox.log, { timeout: 20_000 }).toMatch(new RegExp(`modconn: spawn session=${a.id} resume=true`))
  await expect.poll(() => readDump(dump), { timeout: 20_000 }).toEqual({ E2E_TOKEN: NEW_SECRET, E2E_ADDED: 'a=b', E2E_ENV_DUMP: dump })
  await expect(banner).toHaveCount(0, { timeout: 20_000 })
  await expect.poll(async () => (await listed())?.env_keys).toEqual(['E2E_ADDED', 'E2E_ENV_DUMP', 'E2E_TOKEN'])
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('phone: the editor is a bottom sheet without sideways scroll, and Save and restart applies it', async ({ page, minbox }) => {
    const dump = join(minbox.dataDir, 'env-edit-dump-phone.json')
    await startAgent(minbox, 'phoney', 'proj', { env: { E2E_TOKEN: SECRET, E2E_A_RATHER_LONG_VARIABLE_NAME_FOR_THE_PHONE: '1', E2E_ENV_DUMP: dump } })
    await expect.poll(() => readDump(dump), { timeout: 15_000 }).not.toBeNull()
    await page.goto(minbox.url)
    await page.getByTestId('tab-agents').tap()
    await page.getByTestId('agent-row').filter({ hasText: 'phoney' }).tap()
    await page.getByTestId('agent-menu').tap()
    await page.getByTestId('menu-edit-env').tap()
    const dlg = page.getByRole('dialog', { name: 'Environment variables' })
    await expect(dlg).toBeVisible()
    const token = dlg.getByTestId('agent-env-row').filter({ hasText: 'E2E_TOKEN' })
    await token.getByTestId('agent-env-replace').tap()
    await token.getByTestId('agent-env-replace-input').fill(NEW_SECRET)
    await dlg.getByTestId('agent-env-add').fill('E2E_PHONE=yes')
    const box = await dlg.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 391).toBe(true)
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
    expect(noHScroll).toBe(true)
    await expect(dlg.getByTestId('agent-env-save-restart')).toBeInViewport()
    if (shots) await page.screenshot({ path: join(shots, 'edit-env-phone.png') })
    rmSync(dump)
    await dlg.getByTestId('agent-env-save-restart').tap()
    await expect(dlg).toHaveCount(0)
    await expect
      .poll(() => readDump(dump), { timeout: 20_000 })
      .toEqual({ E2E_TOKEN: NEW_SECRET, E2E_A_RATHER_LONG_VARIABLE_NAME_FOR_THE_PHONE: '1', E2E_PHONE: 'yes', E2E_ENV_DUMP: dump })
    expect(JSON.stringify(await api(minbox, 'GET', '/api/sessions'))).not.toContain(NEW_SECRET)
  })
})

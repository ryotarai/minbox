import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

// The first-run introduction (web/src/v3/Onboarding.tsx): a fresh server shows it; it explains a
// project, an agent and a task while the person makes their first project and agent with the real
// forms, then lands in the agent's stream (its terminal hidden) with a first message ready. Skip works
// at every step, and once done or skipped it does not come back (the server's `onboarded` setting).
// Set MINBOX_SHOT_DIR to save a picture of each step.

const shotDir = process.env.MINBOX_SHOT_DIR
const shot = async (page: Page, name: string) => {
  if (shotDir) await page.screenshot({ path: `${shotDir}/${name}` })
}

const onboarded = async (url: string) => ((await (await fetch(url + '/api/settings')).json()) as { onboarded: boolean }).onboarded

test('a fresh server walks through the introduction: a project, an agent, its stream without the terminal', async ({ page, freshMinbox }) => {
  const repo = join(freshMinbox.dataDir, 'my-app')
  mkdirSync(repo)
  expect(await onboarded(freshMinbox.url)).toBe(false)
  await page.goto(freshMinbox.url)
  const onb = page.getByTestId('onboarding')
  await expect(onb).toBeVisible()

  // Step 1: the three words, with the little diagram.
  await expect(onb.getByRole('heading', { name: 'Welcome to minbox' })).toBeVisible()
  await expect(onb.getByTestId('onboarding-concept-project')).toContainText('a folder or repo you work in')
  await expect(onb.getByTestId('onboarding-concept-agent')).toContainText('Claude Code, Pi or OpenCode')
  await expect(onb.getByTestId('onboarding-concept-task')).toContainText('checklist and a status')
  await expect(onb.getByTestId('onboarding-diagram')).toBeVisible()
  await expect(onb).not.toContainText(/session/i)
  await shot(page, 'onboarding-1-welcome.png')
  await onb.getByTestId('onboarding-next').click()

  // Step 2: the project form. A folder that is not there cannot be used; Back goes to step 1.
  await expect(onb.getByRole('heading', { name: 'Create your first project' })).toBeVisible()
  const cwd = onb.getByTestId('new-session-cwd')
  await cwd.fill(join(freshMinbox.dataDir, 'no-such-folder'))
  await expect(onb.getByTestId('new-session-missing')).toBeVisible()
  await expect(onb.getByTestId('new-session-start')).toBeDisabled()
  await onb.getByTestId('onboarding-back').click()
  await expect(onb.getByRole('heading', { name: 'Welcome to minbox' })).toBeVisible()
  await onb.getByTestId('onboarding-next').click()
  await onb.getByTestId('new-session-cwd').fill(repo)
  await expect(onb.getByTestId('new-session-missing')).toBeHidden()
  await expect(onb.getByTestId('new-session-dir').first()).toBeVisible()
  await onb.getByTestId('new-session-name').fill('My app')
  await expect(onb.getByTestId('new-session-start')).toHaveText(/Create project/)
  await shot(page, 'onboarding-2-project.png')
  await onb.getByTestId('new-session-start').click()

  // Step 3: the New agent form in that project. Pi and OpenCode are not installed here: listed, disabled.
  await expect(onb.getByRole('heading', { name: 'Start your first agent in My app' })).toBeVisible()
  await expect(onb.getByTestId('new-session-project-name')).toHaveText('My app')
  await expect(onb.getByTestId('onboarding-terminal-note')).toContainText('terminal is hidden')
  await expect(onb.getByTestId('new-session-agent-option')).toHaveCount(3)
  await expect(onb.locator('[data-testid="new-session-agent-option"][data-agent="claude"]')).toBeEnabled()
  await expect(onb.locator('[data-testid="new-session-agent-option"][data-agent="claude"]')).toHaveAttribute('aria-checked', 'true')
  for (const k of ['pi', 'opencode']) {
    const b = onb.locator(`[data-testid="new-session-agent-option"][data-agent="${k}"]`)
    await expect(b).toBeDisabled()
    await expect(b).toContainText('not installed')
  }
  await expect(onb.getByTestId('new-session-advanced')).toBeVisible()
  await shot(page, 'onboarding-3-agent.png')
  // Back keeps the project made in step 2 (no second one).
  await onb.getByTestId('onboarding-back').click()
  await expect(onb.getByRole('heading', { name: 'Create your first project' })).toBeVisible()
  await expect(onb.getByTestId('onboarding-use-project')).toHaveText('My app')
  await onb.getByTestId('onboarding-use-project').click()
  await expect(onb.getByRole('heading', { name: 'Start your first agent in My app' })).toBeVisible()
  await onb.getByTestId('new-session-start').click()

  // Step 4: the agent's stream, its terminal hidden, a first message in the box and a hint beside it.
  await expect(onb).toBeHidden()
  const stream = page.getByTestId('stream-view')
  await expect(stream).toBeVisible()
  await expect(page.getByTestId('terminal-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('terminal')).toHaveCount(0)
  await expect(page).toHaveURL(/v=agent/)
  await expect(page).not.toHaveURL(/tab=terminal/)
  await expect(stream.locator('textarea[data-composer]')).toHaveValue(/Take a look around this folder/)
  const hint = page.getByTestId('onboarding-hint')
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('task')
  await shot(page, 'onboarding-4-first-message.png')
  expect(await onboarded(freshMinbox.url)).toBe(true)
  const projects = (await (await fetch(freshMinbox.url + '/api/projects')).json()) as { name: string }[]
  expect(projects.map((p) => p.name)).toEqual(['My app'])

  // The header's toggle still shows and hides the terminal.
  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toBeVisible()
  await page.getByTestId('terminal-toggle').click()
  await expect(page.getByTestId('terminal')).toHaveCount(0)

  await hint.getByTestId('onboarding-done').click()
  await expect(hint).toBeHidden()

  // Not again after a reload.
  await page.reload()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('onboarding')).toHaveCount(0)
})

test('Skip ends the introduction for good; Settings shows it again', async ({ page, freshMinbox }) => {
  await page.goto(freshMinbox.url)
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await page.getByTestId('onboarding-next').click()
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible()
  await page.getByTestId('onboarding-skip').click()
  await expect(page.getByTestId('onboarding')).toHaveCount(0)
  await expect.poll(() => onboarded(freshMinbox.url)).toBe(true)
  // Still nothing made: the empty app, with a way to start (and to see the introduction again).
  await expect(page.getByTestId('first-agent')).toBeVisible()

  // Another browser, or this one reloaded: it does not show again.
  await page.reload()
  await expect(page.getByTestId('v3-app')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('onboarding')).toHaveCount(0)

  // Settings › General › Show the introduction opens it over the main screen.
  await page.goto(freshMinbox.url + '/#v=settings')
  await page.getByTestId('settings-introduction').click()
  await expect(page.getByTestId('onboarding')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Welcome to minbox' })).toBeVisible()
  // Escape skips too.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('onboarding')).toHaveCount(0)
  // And from the empty agent list.
  await page.getByTestId('no-agents-introduction').click()
  await expect(page.getByTestId('onboarding')).toBeVisible()
})

test('a server that is already set up shows no introduction', async ({ page, minbox }) => {
  await page.goto(minbox.url)
  await expect(page.getByTestId('v3-app')).toBeVisible()
  await expect(page.getByTestId('first-agent')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('onboarding')).toHaveCount(0)
})

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the introduction fills the phone screen and makes the project and the agent', async ({ page, freshMinbox }) => {
    const repo = join(freshMinbox.dataDir, 'phone-app')
    mkdirSync(repo)
    await page.goto(freshMinbox.url)
    const onb = page.getByTestId('onboarding')
    await expect(onb).toBeVisible()
    const box = (await onb.locator('.v-onb').boundingBox())!
    expect(box.width).toBeGreaterThanOrEqual(389)
    // Nothing wider than the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await shot(page, 'onboarding-phone-1-welcome.png')
    await onb.getByTestId('onboarding-next').click()
    await onb.getByTestId('new-session-cwd').fill(repo)
    await expect(onb.getByTestId('new-session-missing')).toBeHidden()
    await shot(page, 'onboarding-phone-2-project.png')
    await onb.getByTestId('new-session-start').click()
    await expect(onb.getByRole('heading', { name: /Start your first agent/ })).toBeVisible()
    await shot(page, 'onboarding-phone-3-agent.png')
    await onb.getByTestId('new-session-start').click()
    await expect(onb).toBeHidden()
    await expect(page.getByTestId('stream-view')).toBeVisible()
    await expect(page.getByTestId('onboarding-hint')).toBeVisible()
    await expect(page.locator('textarea[data-composer]')).toHaveValue(/Take a look around this folder/)
    await expect(page.getByTestId('terminal')).toHaveCount(0)
    await shot(page, 'onboarding-phone-4-first-message.png')
    await page.getByTestId('onboarding-done').click()
    await expect(page.getByTestId('onboarding-hint')).toBeHidden()
  })
})

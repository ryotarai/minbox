import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createSession, expect, expectTerminal, selectProject, test, typeInTerminal } from './fixtures'

// Not a check: screenshots of the project UI for docs/ui-v2-projects.md (SCREENSHOTS=1 SCREENSHOT_DIR=docs/img/v2).
test('project screenshots', async ({ page, minbox }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  test.setTimeout(180_000)
  const out = process.env.SCREENSHOT_DIR ?? 'test-results'
  const shot = async (name: string) => {
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/${name}.png` })
  }
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1500, height: 900 })
  const dir = (n: string) => {
    const d = join(minbox.dataDir, 'work', n)
    mkdirSync(d, { recursive: true })
    return d
  }
  await page.goto(minbox.url)
  await createSession(page, dir('deploy-api'), 'api-main')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'ask')
  await expectTerminal(page, /sent question in thr_/)
  await createSession(page, dir('deploy-api'), 'api-migrations')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Migration 0042 applied on staging')
  await expectTerminal(page, /sent .*thr_/)
  await createSession(page, dir('docs'), 'docs-main')
  await expectTerminal(page, 'ready>')
  await typeInTerminal(page, 'say Release notes drafted')
  await expectTerminal(page, /sent .*thr_/)
  await createSession(page, dir('web-ui'), 'ui-main')
  await expectTerminal(page, 'ready>')
  await expect(page.getByTestId('project-item')).toHaveCount(3)

  await selectProject(page, 'deploy-api')
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await shot('p-01-desktop-1500-project-rail')

  await selectProject(page, 'All projects')
  await shot('p-02-all-projects')

  await page.getByTestId('project-new').click()
  await page.getByTestId('new-session-cwd').fill(dir('billing'))
  await shot('p-03-new-project-dialog')
  await page.keyboard.press('Escape')

  await page.getByTestId('composer-target').click()
  await shot('p-04-composer-target-grouped')
  await page.keyboard.press('Escape')

  await selectProject(page, 'deploy-api')
  await page.getByTestId('composer-target').click()
  await shot('p-05-composer-target-main-badge')
  await page.keyboard.press('Escape')

  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('!')
  await shot('p-06-palette-projects')
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('phone-home')).toBeVisible()
  await shot('p-07-phone-home-scoped')
  await page.getByTestId('project-switch').click()
  await shot('p-08-phone-project-sheet')
})

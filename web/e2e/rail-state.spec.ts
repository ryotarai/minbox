// The project rail's open / closed state is one preference (minbox:layout's projectsRail): the
// Board, an agent, a task, Search, My issues (Linear), Slack and the way back from Settings all show
// the rail as the person last left it, also after a reload, on desktop and tablet. No Linear or Slack
// is contacted: their screens render the rail whether or not they are connected.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { say, startAgent, taskNamed } from './v3'

const rail = (page: Page) => page.getByTestId('project-rail')

async function expectRail(page: Page, state: 'open' | 'closed') {
  await expect(rail(page)).toHaveAttribute('data-mode', state === 'closed' ? 'tiles' : 'names')
  const w = (await page.getByTestId('rail-column').boundingBox())!.width
  if (state === 'closed') expect(w).toBeLessThanOrEqual(60)
  else expect(w).toBeGreaterThanOrEqual(170)
}

async function everywhere(page: Page, url: string, a: { id: string }, t: { id: string }, state: 'open' | 'closed') {
  const views = ['', `#v=agent&s=${a.id}`, `#v=task&k=${t.id}`, '#v=search', '#v=issues', '#v=slack']
  for (const v of views) {
    await page.goto(url + '/' + v)
    await expectRail(page, state)
  }
  // Settings has no rail; back from it, the rail is as it was.
  await page.goto(url + '/#v=settings')
  await expect(page.getByTestId('project-rail')).toHaveCount(0)
  await page.goto(url + '/#v=issues')
  await expectRail(page, state)
  await page.goto(url + '/')
  await expectRail(page, state)
  await page.reload()
  await expectRail(page, state)
  await page.goto(url + '/#v=slack')
  await page.reload()
  await expectRail(page, state)
}

for (const width of [1500, 900]) {
  test(`${width}px: the project rail's open / closed state is one, on every screen and across reloads`, async ({ page, minbox }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width, height: 900 })
    const a = await startAgent(minbox, 'api')
    await say(minbox, a, 'please fix the gauge reading')
    const t = await taskNamed(minbox, /Fix the gauge reading/)

    // Closed by default, everywhere.
    await page.goto(minbox.url)
    await expectRail(page, 'closed')
    await page.goto(minbox.url + '/#v=issues')
    await expectRail(page, 'closed')

    // Opened on My issues: open on the Board and everywhere else.
    await page.getByTestId('project-rail-toggle').click()
    await expectRail(page, 'open')
    await everywhere(page, minbox.url, a, t, 'open')

    // Closed on the Board: closed on My issues, Slack, an agent, a task, Search, after a reload.
    await page.goto(minbox.url)
    await page.getByTestId('project-rail-toggle').click()
    await expectRail(page, 'closed')
    await everywhere(page, minbox.url, a, t, 'closed')

    // Opened again from Slack: open on the Board.
    await page.goto(minbox.url + '/#v=slack')
    await page.getByTestId('project-rail-toggle').click()
    await expectRail(page, 'open')
    await page.goto(minbox.url)
    await expectRail(page, 'open')
    await page.reload()
    await expectRail(page, 'open')
  })
}

test('phone: no project rail on any screen, whatever the saved preference', async ({ page, minbox }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url)
  await page.evaluate(() => localStorage.setItem('minbox:layout', JSON.stringify({ projectsRail: false })))
  for (const v of ['', '#v=issues', '#v=slack']) {
    await page.goto(minbox.url + '/' + v)
    await page.reload()
    await expect(rail(page)).toBeHidden()
  }
})

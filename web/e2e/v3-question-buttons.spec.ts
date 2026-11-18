// The question card's action row (Add note / Accept recommended / Skip / Ignore) on narrow screens: a
// label never breaks inside a word ("Ski p", "Ignor e"). Buttons keep their text on one line and the row
// wraps to a second line instead; the page never scrolls sideways.
import { test, expect } from './fixtures'
import { agentReply, say, startAgent, taskNamed } from './v3'
import type { Page } from '@playwright/test'

const SHOTS = process.env.QUESTION_SHOTS // a folder to save screenshots in (off by default)

async function asked(minbox: any) {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  await say(minbox, a, 'ASK about the gauge deploy')
  const q = await agentReply(minbox, a, /One decision first/)
  return { a, t, q }
}

async function expectOneLineButtons(page: Page, block: ReturnType<Page['locator']>) {
  const ids = ['add-note', 'accept-recommended', 'skip-question', 'ignore-question']
  let seen = 0
  for (const id of ids) {
    const b = block.getByTestId(id)
    if (!(await b.count())) continue
    seen++
    const m = await b.evaluate((el) => {
      const r = document.createRange()
      r.selectNodeContents(el)
      const lines = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)))
      const lh = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize) * 1.5
      return { lines: lines.size, scrollW: el.scrollWidth, clientW: el.clientWidth, textH: r.getBoundingClientRect().height, lh, text: el.textContent }
    })
    expect(m.lines, `${id} (${m.text}) on one line`).toBe(1)
    expect(m.textH, `${id} (${m.text}) text height`).toBeLessThanOrEqual(m.lh + 1)
    expect(m.scrollW, `${id} (${m.text}) fits its button`).toBeLessThanOrEqual(m.clientW)
  }
  expect(seen).toBeGreaterThanOrEqual(2)
  const page2 = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
  expect(page2.s, 'no horizontal page scroll').toBeLessThanOrEqual(page2.c)
}

for (const width of [320, 390, 768, 1280]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width < 600 })
    test(`question card buttons keep their labels on one line at ${width}px`, async ({ page, minbox }) => {
      const { t, q } = await asked(minbox)
      for (const view of [`#v=task&k=${t.id}`]) {
        await page.goto(`${minbox.url}/${view}`)
        const card = page.locator(`[data-testid="v3-message"][data-message-id="${q.id}"]`).getByTestId('question-card')
        await expect(card.getByTestId('skip-question')).toBeVisible()
        await card.scrollIntoViewIfNeeded()
        for (const theme of ['light', 'dark'] as const) {
          await page.evaluate((th) => (document.documentElement.dataset.theme = th), theme)
          if (SHOTS) await card.screenshot({ path: `${SHOTS}/question-buttons-${width}-${theme}.png` })
          await expectOneLineButtons(page, card)
        }
      }
    })
  })
}

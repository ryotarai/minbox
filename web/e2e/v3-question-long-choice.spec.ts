// A long choice (here Japanese, three lines on a phone) grows its box: the text wraps inside the option,
// left-aligned with the icon at its first line, in the open card (pick one and pick any), once answered,
// and in the answers shown under the question. Nothing spills out of its box and the page never scrolls
// sideways, on a phone and on a desktop.
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { agentReply, api, say, startAgent, type Agent } from './v3'
import type { Locator, Page } from '@playwright/test'

const SHOTS = process.env.QUESTION_SHOTS // a folder to save screenshots in (off by default)

const LONG = 'ツール定義が変わったら、プラグインが Claude Code に強制的に更新させる（breakPromptCache）— Claude Code がこの指定に対応しているかは未確認なので、まず確認から'

/** The agent API, as the agent's mod calls it (its session's token). */
async function as(m: any, a: Agent, method: string, path: string, body?: unknown): Promise<any> {
  const db = readdirSync(m.dataDir).find((f) => f.endsWith('.db'))!
  const token = execFileSync('sqlite3', [join(m.dataDir, db)], { input: `.timeout 5000\nSELECT token FROM sessions WHERE id='${a.id}';\n` }).toString().trim()
  const r = await fetch(m.url + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

const BODY = (tag: string) =>
  `${tag}\n\n:::question-multi\nどう直しますか？（複数選べます）\n- [ ] ${LONG}\n- [ ] 何もしない\nRecommended: 何もしない\n:::\n\n:::question\nどちらにしますか？\n- [ ] ${LONG}\n- [ ] 何もしない\n:::`

async function cards(minbox: any) {
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'hello')
  await agentReply(minbox, a, /./)
  await as(minbox, a, 'POST', '/api/agent/messages', { body: BODY('Answered one.'), task_status: 'needs_you' })
  const done = await agentReply(minbox, a, /Answered one\./)
  const ans = await api(minbox, 'POST', `/api/v3/sessions/${a.id}/messages`, {
    words: '',
    answers_for: done.id,
    answers: done.questions.map((q: any) => ({ key: q.key, selected: [LONG] })),
  })
  await as(minbox, a, 'POST', '/api/agent/messages', { body: BODY('Open one.'), task_status: 'needs_you' })
  const open = await agentReply(minbox, a, /Open one\./)
  return { a, done, open, ans }
}

/** Every choice's text lies inside its box (with some padding), starts at its left, and the icon sits at the first line. */
async function expectFits(page: Page, scope: Locator, what: string) {
  const choices = scope.getByTestId('choice')
  const n = await choices.count()
  expect(n, `${what}: choices`).toBeGreaterThan(0)
  for (let i = 0; i < n; i++) {
    const m = await choices.nth(i).evaluate((el) => {
      const box = el.getBoundingClientRect()
      const r = document.createRange()
      r.selectNodeContents(el)
      const t = r.getBoundingClientRect()
      const icon = el.querySelector('[aria-hidden="true"]')!.getBoundingClientRect()
      const rects = [...r.getClientRects()].filter((x) => x.width > 0)
      const lines = new Set(rects.map((x) => Math.round(x.top))).size
      return {
        box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
        text: { top: t.top, bottom: t.bottom, left: t.left, right: t.right },
        iconTop: icon.top,
        lines,
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        align: getComputedStyle(el).textAlign,
        label: el.getAttribute('aria-label'),
      }
    })
    const at = `${what}: choice ${i} (${m.label?.slice(0, 12)}…)`
    expect(m.text.top, `${at} text below the box top`).toBeGreaterThanOrEqual(m.box.top + 4)
    expect(m.text.bottom, `${at} text above the box bottom`).toBeLessThanOrEqual(m.box.bottom - 4)
    expect(m.text.left, `${at} text right of the box left`).toBeGreaterThanOrEqual(m.box.left + 4)
    expect(m.text.right, `${at} text left of the box right`).toBeLessThanOrEqual(m.box.right - 4)
    expect(m.scrollW, `${at} no sideways overflow`).toBeLessThanOrEqual(m.clientW)
    expect(m.align, `${at} left-aligned`).toMatch(/left|start/)
    // The icon sits at the first line, not in the middle of a wrapped label.
    expect(m.iconTop - m.text.top, `${at} icon at the first line`).toBeLessThan(12)
    if (m.label === LONG && (await page.viewportSize())!.width < 600) expect(m.lines, `${at} wraps`).toBeGreaterThan(1)
  }
}

async function expectNoPageScroll(page: Page) {
  const s = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
  expect(s.s, 'no horizontal page scroll').toBeLessThanOrEqual(s.c)
}

for (const width of [390, 1280]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width < 600 })
    test(`a long choice wraps inside its box at ${width}px`, async ({ page, minbox }) => {
      const { a, done, open, ans } = await cards(minbox)
      await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
      const doneMsg = page.locator(`[data-testid="v3-message"][data-message-id="${done.id}"]`)
      const openMsg = page.locator(`[data-testid="v3-message"][data-message-id="${open.id}"]`)
      await expect(doneMsg.getByTestId('question-card')).toHaveCount(2)
      await expect(doneMsg.getByTestId('question-card').first()).toHaveAttribute('data-state', 'Answered')
      await expect(openMsg.getByTestId('question-card').first()).toHaveAttribute('data-state', 'Open')
      // Pick the long choice in the open pick-any card too: a selected, unsent choice.
      await openMsg.getByTestId('question-card').first().getByRole('checkbox', { name: LONG }).click()
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((th) => (document.documentElement.dataset.theme = th), theme)
        for (const [name, msg] of [['answered', doneMsg], ['open', openMsg]] as const) {
          const cs = msg.getByTestId('question-card')
          for (let i = 0; i < 2; i++) {
            const card = cs.nth(i)
            await card.scrollIntoViewIfNeeded()
            if (SHOTS) await card.screenshot({ path: `${SHOTS}/long-choice-${width}-${theme}-${name}-${i ? 'single' : 'multi'}.png` })
            await expectFits(page, card, `${name} ${i ? 'single' : 'multi'} (${theme})`)
          }
        }
        // The answers under the question: the long answer wraps inside the bubble.
        const sent = page.locator(`[data-testid="v3-message"][data-message-id="${ans.id}"]`).getByTestId('sent-answers')
        await sent.scrollIntoViewIfNeeded()
        if (SHOTS) await sent.screenshot({ path: `${SHOTS}/long-choice-${width}-${theme}-sent.png` })
        const items = sent.locator('.v-sans-a')
        await expect(items).toHaveCount(2)
        for (let i = 0; i < 2; i++) {
          const m = await items.nth(i).evaluate((el) => {
            const box = el.getBoundingClientRect()
            const r = document.createRange()
            r.selectNodeContents(el)
            const t = r.getBoundingClientRect()
            const outer = el.closest('[data-testid="sent-answers"]')!.getBoundingClientRect()
            return { box, t, outer, scrollW: el.scrollWidth, clientW: el.clientWidth }
          })
          expect(m.t.top, 'sent answer text inside').toBeGreaterThanOrEqual(m.box.top - 1)
          expect(m.t.bottom, 'sent answer text inside').toBeLessThanOrEqual(m.box.bottom + 1)
          // pre-wrap lets a space hang at a line's end (invisible): allow one space's width.
          expect(m.t.right, 'sent answer text inside its bubble').toBeLessThanOrEqual(m.outer.right + 5)
          expect(m.scrollW, 'sent answer no sideways overflow').toBeLessThanOrEqual(m.clientW)
        }
        await expectNoPageScroll(page)
      }
    })
  })
}

// A truncated line's "…" takes the colour of the text it cuts: the ellipsis is drawn in the colour
// of the element that truncates, so a line of differently coloured parts (an agent's name in the
// primary colour, its "main · Claude Code" in grey) truncates each part on its own.
import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures'
import { startAgent } from './v3'

/** For each element under root that truncates with an ellipsis right now: its colour and the colour of the last text it holds. */
const cuts = (root: Locator) =>
  root.evaluate((r) => {
    const out: { text: string; own: string; last: string }[] = []
    for (const el of [r, ...r.querySelectorAll('*')] as HTMLElement[]) {
      const cs = getComputedStyle(el)
      if (cs.textOverflow !== 'ellipsis' || cs.overflow === 'visible' || el.scrollWidth <= el.clientWidth) continue
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) })
      let last: Node | null = null
      for (let n = w.nextNode(); n; n = w.nextNode()) last = n
      if (!last?.parentElement) continue
      out.push({ text: el.textContent ?? '', own: cs.color, last: getComputedStyle(last.parentElement).color })
    }
    return out
  })

test('the ellipsis of a truncated agent row and agent header has the colour of the text it cuts', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'a-rather-long-agent-name')
  await page.goto(minbox.url)
  const row = page.locator(`[data-testid="agent-row"][data-session="${a.id}"]`)
  await expect(row).toBeVisible()
  // The grey meta ("Claude Code") is what overflows the 236px sidebar, not the name.
  const meta = row.locator('.v-nm small')
  expect(await meta.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  const found = await cuts(row)
  expect(found.length).toBeGreaterThan(0)
  for (const c of found) expect(c.own, `ellipsis colour of “${c.text}”`).toBe(c.last)

  await row.click()
  const head = page.getByTestId('agent-name')
  await expect(head).toContainText('a-rather-long-agent-name')
  for (const c of await cuts(head)) expect(c.own, `ellipsis colour of “${c.text}”`).toBe(c.last)
})

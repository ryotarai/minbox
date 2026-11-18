// UC11 / UC6 on a phone: an agent's stream and a task open at their newest message, also when images
// load late and the content grows after the first layout, whether opened from the Agents tab, the
// Board or a deep link; scrolled up, a new message shows the pill and the view does not jump.
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { agentReply, say, startAgent, taskNamed, type Agent } from './v3'
import type { Minbox } from './fixtures'
import { deflateSync } from 'node:zlib'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

// A w×h PNG (one colour): big enough to change the layout when it arrives.
function png(w: number, h: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x88)])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

async function upload(m: Minbox, name: string, body: Buffer): Promise<string> {
  const r = await fetch(`${m.url}/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', body })
  const j = await r.json()
  return j.upload.upload_id
}

/** A long conversation with images: the person's messages carry them, the fake agent answers each. */
async function longStream(m: Minbox, a: Agent, n: number) {
  for (let i = 0; i < n; i++) {
    const uploads = i % 3 === 0 ? [await upload(m, `shot-${i}.png`, png(600, 900))] : undefined
    await fetch(`${m.url}/api/v3/sessions/${a.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: `is the staging server up? (${i})`, uploads }),
    })
    await agentReplies(m, a, i + 1)
  }
}

/** Waits until the agent has answered n times. */
async function agentReplies(m: Minbox, a: Agent, n: number) {
  await expect
    .poll(async () => {
      const s = await (await fetch(`${m.url}/api/v3/sessions/${a.id}/stream`)).json()
      return s.messages.filter((x: any) => x.author === 'agent').length
    }, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(n)
}

const scroller = (page: Page, view: 'stream-view' | 'agent-task-detail') => page.getByTestId(view).locator('.v-scroll').first()
const gapToBottom = (page: Page, view: 'stream-view' | 'agent-task-detail') =>
  scroller(page, view).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)

/** Images arrive late (as on a phone network), so the content grows after the first layout. */
async function slowImages(page: Page) {
  await page.route('**/api/attachments/**', async (r) => {
    await new Promise((res) => setTimeout(res, 1200))
    await r.continue()
  })
}

test('phone: an agent stream opens at its newest message, from the Agents tab and from a link, images loading late', async ({ page, minbox }) => {
  test.setTimeout(120_000)
  const a = await startAgent(minbox, 'api')
  await longStream(minbox, a, 9)
  await slowImages(page)
  // Read it once (so nothing is "new"), then come back from the Agents tab.
  await page.goto(`${minbox.url}/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await expect.poll(() => gapToBottom(page, 'stream-view'), { timeout: 8000 }).toBeLessThan(4)
  // The images arrived: still at the bottom.
  await page.waitForTimeout(1800)
  expect(await gapToBottom(page, 'stream-view')).toBeLessThan(4)
  const last = page.getByTestId('stream-view').getByTestId('v3-message').last()
  await expect(last).toBeInViewport()

  await page.getByTestId('tab-board').tap()
  await page.getByTestId('tab-agents').tap()
  await page.getByTestId('agent-row').filter({ hasText: 'api' }).tap()
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await page.waitForTimeout(1800)
  expect(await gapToBottom(page, 'stream-view')).toBeLessThan(4)
  await expect(page.getByTestId('stream-view').getByTestId('v3-message').last()).toBeInViewport()
  // The reply box is on screen under the messages (not scrolled away with them).
  await expect(page.getByTestId('composer-text')).toBeInViewport()
  // The page itself does not scroll: the list does.
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0)

  // Content that grows late (a diagram, a code block) keeps it at the bottom too.
  await last.evaluate((el) => {
    const d = document.createElement('div')
    d.style.height = '600px'
    el.appendChild(d)
  })
  await expect.poll(() => gapToBottom(page, 'stream-view')).toBeLessThan(4)

  // Scrolled up, a new message shows the pill and the view stays where it is.
  await scroller(page, 'stream-view').evaluate((el) => el.scrollBy(0, -1500))
  await page.waitForTimeout(300)
  const top = await scroller(page, 'stream-view').evaluate((el) => el.scrollTop)
  await say(minbox, a, 'is the staging server up? (late)')
  await expect(page.getByTestId('new-message-pill')).toBeVisible({ timeout: 15_000 })
  expect(Math.abs((await scroller(page, 'stream-view').evaluate((el) => el.scrollTop)) - top)).toBeLessThan(4)
})

test('phone: a task opens at its newest message from the Board, with late images', async ({ page, minbox }) => {
  test.setTimeout(120_000)
  const a = await startAgent(minbox, 'api')
  await say(minbox, a, 'please fix the gauge reading')
  const t = await taskNamed(minbox, /Fix the gauge reading/)
  await agentReply(minbox, a, /created a task/)
  for (let i = 0; i < 6; i++) {
    const uploads = [await upload(minbox, `gauge-${i}.png`, png(600, 900))]
    await fetch(`${minbox.url}/api/v3/sessions/${a.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: `the gauge reading is off by one (${i})`, task_id: t.id, uploads }),
    })
    await agentReplies(minbox, a, i + 2)
  }
  await slowImages(page)
  await page.goto(minbox.url)
  await page.locator(`[data-testid="task-row"][data-task="${t.id}"] .v-line`).tap()
  await expect(page.getByTestId('agent-task-detail')).toBeVisible()
  await page.waitForTimeout(1800)
  expect(await gapToBottom(page, 'agent-task-detail')).toBeLessThan(4)
  await expect(page.getByTestId('agent-task-detail').getByTestId('v3-message').last()).toBeInViewport()
  await expect(page.getByTestId('task-composer').getByTestId('composer-text')).toBeInViewport()

  // A deep link lands the same way.
  await page.goto('about:blank')
  await page.goto(`${minbox.url}/#v=task&k=${t.id}`)
  await expect(page.getByTestId('agent-task-detail')).toBeVisible()
  await page.waitForTimeout(1800)
  expect(await gapToBottom(page, 'agent-task-detail')).toBeLessThan(4)
})

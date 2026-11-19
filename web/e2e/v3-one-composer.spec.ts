// One task picked (in an agent's page or in All agents): the page has one message box, the task's own
// (the Tasks pane's box is not shown then). Send (⌘↵) sends about the task; the quieter "Send without
// task" (⇧⌘↵) sends to the agent's stream untagged: the agent whose page it is, or in All agents the
// task's agent, whoever the box's "to" names. An IME's Enter never sends. On a phone both buttons show.
import type { Locator, Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { api, startAgent, type Agent } from './v3'

/** ONE_COMPOSER_SHOTS=<dir>: screenshots (for review). */
async function shot(page: Page, name: string) {
  const dir = process.env.ONE_COMPOSER_SHOTS
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, name + '.png') })
}

type M = Parameters<typeof startAgent>[0]

/** The person's message with these words in the agent's stream: the tasks the person sent it about
 *  (null: not there). The agent may place an untagged message in a task later (source "agent"): that
 *  is not the person's tag. */
async function sentTo(minbox: M, a: Agent, words: string): Promise<string[] | null> {
  const s = await api(minbox, 'GET', `/api/v3/sessions/${a.id}/stream`)
  const m = s.messages.find((x: any) => x.author === 'user' && x.words === words)
  return m ? (m.tasks ?? []).filter((x: any) => x.source === 'person').map((x: any) => x.task_id) : null
}

/** Waits until the box has finished sending (a key pressed meanwhile does nothing). */
async function sent(box: Locator) {
  await expect(box.getByTestId('composer-send')).toHaveText(/^Send(⌘↵|Ctrl\+↵)?$/)
}

test('an agent page with a task picked: one box; Send is about the task, ⇧⌘↵ and "Send without task" go to the agent untagged; IME Enter does not send', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  const t = await api(minbox, 'POST', '/api/v3/tasks', { project_id: a.project_id, title: 'Fix the gauge reading', session_id: a.id })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}&k=${t.id}`)
  await expect(page.getByTestId('agent-task-detail')).toBeVisible()

  // One box: the task's (none in the Tasks pane, no stream box).
  await expect(page.getByTestId('composer-text')).toHaveCount(1)
  await expect(page.getByTestId('tasks-composer')).toHaveCount(0)
  const box = page.getByTestId('task-composer')
  const text = box.getByTestId('composer-text')
  const plain = box.getByTestId('composer-send-untagged')
  // The shortcuts sit inside the buttons, not beside them (and stay out of the buttons' accessible names).
  await expect(plain).toHaveText(/^Send without task(⇧⌘↵|Shift\+Ctrl\+↵)$/)
  await expect(plain.getByTestId('send-key')).toBeVisible()
  await expect(box.getByTestId('composer-send').getByTestId('send-key')).toHaveText(/^(⌘↵|Ctrl\+↵)$/)
  await expect(box.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
  await expect(plain).toHaveAttribute('title', /⇧⌘↵|Shift\+Ctrl\+Enter/)
  await expect(plain).toBeDisabled()
  await text.fill('draft for the shot')
  await shot(page, 'desktop-task')
  await text.fill('')

  // Send (⌘↵): about the task.
  await text.fill('use the shorter wording')
  await text.press('ControlOrMeta+Enter')
  await expect.poll(() => sentTo(minbox, a, 'use the shorter wording')).toEqual([t.id])
  await expect(text).toHaveValue('')
  await sent(box)

  // ⇧⌘↵: to the page's agent, untagged, even with another agent in "to".
  await box.getByTestId('composer-to').selectOption(b.id)
  await text.fill('how is the deploy going?')
  await text.press('Shift+ControlOrMeta+Enter')
  await expect.poll(() => sentTo(minbox, a, 'how is the deploy going?')).toEqual([])
  expect(await sentTo(minbox, b, 'how is the deploy going?')).toBeNull()
  await expect(page.getByText(`Sent to ${a.name} without the task`)).toBeVisible()
  await expect(text).toHaveValue('')
  await sent(box)

  // The button: the same.
  await text.fill('and the release notes')
  await plain.click()
  await expect.poll(() => sentTo(minbox, a, 'and the release notes')).toEqual([])
  await sent(box)

  // An IME composing Enter (⌘↵ or ⇧⌘↵) never sends.
  await text.fill('かんじ')
  await text.focus()
  await text.evaluate((el) => {
    const key = (init: KeyboardEventInit, code229 = false) => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })
      if (code229) Object.defineProperty(e, 'keyCode', { get: () => 229 })
      el.dispatchEvent(e)
    }
    key({ metaKey: true, ctrlKey: true, isComposing: true })
    key({ metaKey: true, ctrlKey: true, shiftKey: true, isComposing: true })
    key({ metaKey: true, ctrlKey: true }, true)
  })
  await page.waitForTimeout(500)
  await expect(text).toHaveValue('かんじ')
  expect(await sentTo(minbox, a, 'かんじ')).toBeNull()

  // No task picked: the stream's own box, with no "Send without task".
  await page.goto(minbox.url + `/#v=agent&s=${a.id}`)
  await expect(page.getByTestId('stream-view')).toBeVisible()
  await expect(page.getByTestId('composer-text')).toHaveCount(1)
  await expect(page.getByTestId('composer-send-untagged')).toHaveCount(0)
})

test('All agents with a task picked: one box; "Send without task" goes to the task’s agent untagged', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const b = await startAgent(minbox, 'web')
  const t = await api(minbox, 'POST', '/api/v3/tasks', { project_id: b.project_id, title: 'Restyle the login page', session_id: b.id })
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(minbox.url + '/#v=alltasks')
  await expect(page.getByTestId('all-agents-empty')).toBeVisible()
  await expect(page.getByTestId('composer-text')).toHaveCount(0)
  await page.goto(minbox.url + `/#v=alltasks&k=${t.id}`)
  const box = page.getByTestId('task-composer')
  await expect(box).toBeVisible()
  await expect(page.getByTestId('composer-text')).toHaveCount(1)

  await box.getByTestId('composer-text').fill('about the login page')
  await box.getByTestId('composer-send').click()
  await expect.poll(() => sentTo(minbox, b, 'about the login page')).toEqual([t.id])
  await sent(box)

  await box.getByTestId('composer-to').selectOption(a.id)
  await box.getByTestId('composer-text').fill('anything else on your plate?')
  await box.getByTestId('composer-send-untagged').click()
  await expect.poll(() => sentTo(minbox, b, 'anything else on your plate?')).toEqual([])
  expect(await sentTo(minbox, a, 'anything else on your plate?')).toBeNull()
})

test('a phone with a task picked: one box, both buttons in reach, no horizontal scroll', async ({ page, minbox }) => {
  const a = await startAgent(minbox, 'api')
  const t = await api(minbox, 'POST', '/api/v3/tasks', { project_id: a.project_id, title: 'Fix the gauge reading', session_id: a.id })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(minbox.url + `/#v=agent&s=${a.id}&k=${t.id}`)
  const box = page.getByTestId('task-composer')
  await expect(box).toBeVisible()
  await expect(page.getByTestId('composer-text')).toHaveCount(1)
  const send = box.getByTestId('composer-send')
  const plain = box.getByTestId('composer-send-untagged')
  await box.getByTestId('composer-text').fill('from the phone, no task')
  for (const b of [send, plain]) {
    await expect(b).toBeVisible()
    const bb = (await b.boundingBox())!
    expect(bb.x).toBeGreaterThanOrEqual(0)
    expect(bb.x + bb.width).toBeLessThanOrEqual(390)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  // No keyboard shortcut on a phone: the keys inside the buttons are hidden.
  await expect(send.getByTestId('send-key')).toBeHidden()
  await expect(plain.getByTestId('send-key')).toBeHidden()
  await shot(page, 'phone-task')
  await plain.click()
  await expect.poll(() => sentTo(minbox, a, 'from the phone, no task')).toEqual([])
  await sent(box)
  await box.getByTestId('composer-text').fill('from the phone, about the task')
  await send.click()
  await expect.poll(() => sentTo(minbox, a, 'from the phone, about the task')).toEqual([t.id])
})

// Helpers of the v3 specs (docs/v3/usecases.md): agents are started through the API (with the fake
// claude, which answers stream messages by itself: see fake-claude.py's decide()), and the person's
// messages are sent through the API when a test only needs data.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'
import type { Minbox } from './fixtures'

export type Agent = { id: string; name: string; project_id: string }

async function api(m: Minbox, method: string, path: string, body?: unknown): Promise<any> {
  const r = await fetch(m.url + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/** Starts an agent (a fake claude session) in dir (default: a "proj" folder of the data dir) and waits until it is idle. */
export async function startAgent(m: Minbox, name: string, dir = 'proj', extra: Record<string, unknown> = {}): Promise<Agent> {
  const cwd = join(m.dataDir, dir)
  mkdirSync(cwd, { recursive: true })
  const s = await api(m, 'POST', '/api/sessions', { cwd, name, ...extra })
  await expect.poll(async () => (await api(m, 'GET', '/api/sessions')).find((x: any) => x.id === s.id)?.status, { timeout: 15_000 }).toBe('idle')
  return { id: s.id, name, project_id: s.project_id }
}

/** The person writes to an agent (as the composer does). */
export async function say(m: Minbox, a: Agent, words: string, taskIds?: string[]): Promise<any> {
  return api(m, 'POST', `/api/v3/sessions/${a.id}/messages`, { words, task_id: taskIds?.[0] })
}

export async function board(m: Minbox, project = ''): Promise<any> {
  return api(m, 'GET', '/api/v3/board' + (project ? '?project=' + project : ''))
}

/** Waits until the agent's stream has an agent message whose body matches re; returns it. */
export async function agentReply(m: Minbox, a: Agent, re: RegExp): Promise<any> {
  let found: any = null
  await expect
    .poll(
      async () => {
        const s = await api(m, 'GET', `/api/v3/sessions/${a.id}/stream`)
        found = [...s.messages].reverse().find((x: any) => x.author === 'agent' && re.test(x.body))
        return !!found
      },
      { timeout: 20_000 },
    )
    .toBe(true)
    .catch(async (e) => {
      const s = await api(m, 'GET', `/api/v3/sessions/${a.id}/stream`)
      console.log('stream of ' + a.name + ':\n' + s.messages.map((x: any) => `${x.author} [${x.kind}] ${x.delivery ?? ''} ${x.body.slice(0, 80)}`).join('\n'))
      throw e
    })
  return found
}

/** Waits for a task with this title; returns it (as the Board lists it). */
export async function taskNamed(m: Minbox, title: string | RegExp): Promise<any> {
  let t: any = null
  await expect
    .poll(
      async () => {
        const b = await board(m)
        t = b.tasks.find((x: any) => (typeof title === 'string' ? x.title === title : title.test(x.title)))
        return !!t
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  return t
}

export { api }

/** Saves a screenshot of the use-case flow into docs/v3/screens (UX review), light or dark. */
export async function shot(page: Page, name: string, theme?: 'light' | 'dark') {
  if (!process.env.V3_SHOTS) return // V3_SHOTS=1 npx playwright test e2e/v3- refreshes them
  const dir = join(__dirname_v3(), '../../docs/v3/screens')
  mkdirSync(dir, { recursive: true })
  if (theme) await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme)
  await page.screenshot({ path: join(dir, `${name}${theme ? '-' + theme : ''}.png`) })
}

function __dirname_v3() {
  return new URL('.', import.meta.url).pathname
}

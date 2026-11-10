// Tests of the Pi extension against a mock of Pi's ExtensionAPI and a scripted minbox server.
// Run: node --test plugin/pi/minbox.test.ts   (Node 22.18+ strips the types itself)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install, TOOL_PREFIX, type Deps } from './minbox.ts'

type Call = { method: string; path: string; body: any }

function setup(opts: { env?: Record<string, string>; pending?: () => any[]; fail?: (c: Call) => boolean } = {}) {
  const handlers = new Map<string, Function>()
  const tools = new Map<string, any>()
  const sent: { text: string; opts?: any }[] = []
  const calls: Call[] = []
  const order: string[] = []
  let clock = 1_000_000
  let sendThrows = false
  const done = new Set<string>()
  const pi = {
    on: (ev: string, h: Function) => handlers.set(ev, h),
    registerTool: (t: any) => tools.set(t.name, t),
    sendUserMessage: (text: string, o?: any) => {
      if (sendThrows) throw new Error('nope')
      order.push('send')
      sent.push({ text, opts: o })
    },
  }
  const deps: Deps = {
    env: opts.env ?? { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: '/srv.json' },
    readFile: () => JSON.stringify({ url: 'http://127.0.0.1:1' }),
    now: () => clock,
    sleep: () => new Promise((r) => setTimeout(r, 5)), // the fake clock only moves with advance()
    randomId: () => 'owner1',
    fetch: async (url, init) => {
      const u = new URL(url)
      const c: Call = { method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined }
      calls.push(c)
      if (opts.fail?.(c)) return { ok: false, status: 500, text: async () => '{"error":"boom"}' }
      const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) })
      if (u.pathname === '/api/agent/pending' && init.method === 'GET') return ok((opts.pending ? opts.pending() : []).filter((p: any) => !done.has(p.id)))
      if (u.pathname.endsWith('/claim')) return ok({ claimed: true })
      if (u.pathname.endsWith('/release')) {
        order.push('release')
        return ok({ ok: true })
      }
      if (u.pathname.endsWith('/delivered')) {
        order.push('delivered')
        done.add(decodeURIComponent(u.pathname.split('/').slice(-2)[0]))
        return ok({ ok: true })
      }
      if (u.pathname === '/api/agent/messages') return ok({ thread_id: 'thr_1', new_thread: true })
      if (u.pathname === '/api/agent/title') return ok({ ok: true, title: 'T' })
      return ok({})
    },
  }
  const ext = install(pi, deps)
  const ctx = (idle: () => boolean) => ({ sessionManager: { getSessionId: () => 'conv-1', getSessionFile: () => '/s/a_conv-1.jsonl' }, isIdle: idle })
  return { handlers, tools, sent, calls, order, ext, ctx, advance: (ms: number) => (clock += ms), setSendThrows: (v: boolean) => (sendThrows = v) }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

test('does nothing without the minbox environment', () => {
  const t = setup({ env: {} })
  assert.equal(t.ext, null)
  assert.equal(t.tools.size, 0)
  assert.equal(t.handlers.size, 0)
})

test('registers the minbox tools under Pi names', () => {
  const t = setup()
  for (const n of ['send_message', 'read_thread', 'set_session_title', 'open_url', 'card']) assert.ok(t.tools.has(TOOL_PREFIX + n), n)
  assert.equal(t.tools.get('minbox_send_message').parameters.required.includes('thread_title'), true)
  t.ext!.stop()
})

test('send_message validates, posts, and throws on a server error', async () => {
  const t = setup({ fail: (c) => c.path === '/api/agent/title' })
  const send = t.tools.get('minbox_send_message')
  await assert.rejects(send.execute('1', { body: '', status: 'working', thread_title: 'x' }), /body is required/)
  await assert.rejects(send.execute('1', { body: 'hi', thread_title: 'x' }), /status is required/)
  await assert.rejects(send.execute('1', { body: 'hi', status: 'finished' }), /thread_title is required/)
  const r = await send.execute('1', { body: 'hi', status: 'need_action', thread_title: 'Pick one' })
  assert.match(r.content[0].text, /Started thread thr_1/)
  const post = t.calls.find((c) => c.path === '/api/agent/messages')!
  assert.deepEqual([post.body.body, post.body.status, post.body.thread_title], ['hi', 'need_action', 'Pick one'])
  await assert.rejects(t.tools.get('minbox_set_session_title').execute('1', { title: 'T' }), /minbox: boom/)
  t.ext!.stop()
})

test('bash commands that open a page on the host are blocked', async () => {
  const t = setup()
  const h = t.handlers.get('tool_call')!
  const blocked = await h({ toolName: 'bash', input: { command: 'gh pr view --web' } })
  assert.equal(blocked.block, true)
  assert.match(blocked.reason, /minbox_open_url/)
  assert.equal(await h({ toolName: 'bash', input: { command: 'ls -la' } }), undefined)
  assert.equal(await h({ toolName: 'read', input: { path: 'a' } }), undefined)
  t.ext!.stop()
})

test('agent_start and agent_settled report working and idle', async () => {
  const t = setup()
  await t.handlers.get('agent_start')!({})
  await t.handlers.get('agent_settled')!({ aborted: false })
  await settle()
  const st = t.calls.filter((c) => c.path === '/api/agent/status').map((c) => c.body.status)
  assert.deepEqual(st, ['working', 'idle'])
  t.ext!.stop()
})

test('session_start sends the hello with the conversation id and file, then delivery waits for quiet', async () => {
  let pending: any[] = [{ id: 'm1', thread_id: 'thr_9', subject: 'Re: db', body: 'use sqlite', new_thread: false, urgent: false }]
  const t = setup({ pending: () => pending })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  const hello = t.calls.find((c) => c.path === '/api/agent/hello')!
  assert.deepEqual([hello.body.agent, hello.body.agent_session_id, hello.body.session_file], ['pi', 'conv-1', '/s/a_conv-1.jsonl'])
  await settle()
  assert.equal(t.sent.length, 0, 'not quiet yet: nothing is claimed')
  assert.equal(t.calls.some((c) => c.path.includes('/claim')), false)
  t.advance(5000)
  await settle()
  assert.equal(t.sent.length, 1)
  assert.match(t.sent[0].text, /minbox inbox: Re: db \(thread_id: thr_9\)/)
  assert.match(t.sent[0].text, /minbox_send_message/)
  assert.equal(t.sent[0].opts, undefined)
  // claim -> send -> delivered
  const seq = t.calls.map((c) => c.path.replace(/\?.*/, '').replace(/.*\//, '')).filter((p) => ['claim', 'delivered'].includes(p))
  assert.deepEqual(seq.slice(0, 2), ['claim', 'delivered'])
  assert.deepEqual(t.order.slice(0, 2), ['send', 'delivered'])
  t.ext!.stop()
  pending = []
})

test('a busy Pi takes only urgent messages, as steering; a failed delivery is released', async () => {
  let pending: any[] = [
    { id: 'w', thread_id: 'a', subject: 's', body: 'wait', new_thread: false, urgent: false },
    { id: 'u', thread_id: 'b', subject: 's', body: 'now', new_thread: false, urgent: true },
  ]
  const t = setup({ pending: () => pending })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => false))
  await t.handlers.get('agent_start')!({})
  await settle()
  assert.ok(t.sent.length >= 1)
  assert.deepEqual(t.sent[0].opts, { deliverAs: 'steer' })
  assert.match(t.sent[0].text, /now/)
  assert.doesNotMatch(t.sent[0].text, /wait/)
  t.ext!.stop()
  pending = []
  await settle()

  const t2 = setup({ pending: () => [{ id: 'u', thread_id: 'b', subject: 's', body: 'now', new_thread: false, urgent: true }] })
  t2.setSendThrows(true)
  await t2.handlers.get('session_start')!({ reason: 'startup' }, t2.ctx(() => true))
  await settle()
  assert.ok(t2.order.includes('release'))
  assert.equal(t2.order.includes('delivered'), false)
  t2.ext!.stop()
})

test('a busy turn with no event for 120 s is given up on, unless a subagent or a tool update shows life', async () => {
  const statuses = (t: ReturnType<typeof setup>) => t.calls.filter((c) => c.path === '/api/agent/status').map((c) => c.body.status)
  // No sign of life: the stale rule turns it idle again.
  const a = setup()
  await a.handlers.get('session_start')!({ reason: 'startup' }, a.ctx(() => false))
  await a.handlers.get('agent_start')!({})
  a.advance(130_000)
  await settle()
  assert.equal(statuses(a).at(-1), 'idle')
  a.ext!.stop()

  // The shared marker (subagent.ts) counts as life.
  const { touchBusy } = await import('./busy.ts')
  const b = setup()
  await b.handlers.get('session_start')!({ reason: 'startup' }, b.ctx(() => false))
  await b.handlers.get('agent_start')!({})
  await settle()
  b.advance(130_000)
  touchBusy()
  await settle()
  assert.equal(statuses(b).at(-1), 'working')
  b.ext!.stop()

  // So does a tool_execution_update (a streaming minbox_subagent result).
  const c = setup()
  await c.handlers.get('session_start')!({ reason: 'startup' }, c.ctx(() => false))
  await c.handlers.get('agent_start')!({})
  await settle()
  c.advance(130_000)
  await c.handlers.get('tool_execution_update')!({})
  await settle()
  assert.equal(statuses(c).at(-1), 'working')
  c.ext!.stop()
})

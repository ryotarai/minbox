// Tests of the Pi extension as a proxy (mod protocol 1) against a mock of Pi's ExtensionAPI and a
// scripted minbox server serving the real tool set (plugin/testdata/manifest-pi.json, kept equal to
// the server's by TestManifestFixtures). The wording is the server's and is tested there.
// Run: node --test plugin/pi/minbox.test.ts   (Node 22.18+ strips the types itself)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { install, type Deps } from './minbox.ts'

const MANIFEST = JSON.parse(readFileSync(new URL('../testdata/manifest-pi.json', import.meta.url), 'utf8'))

type Call = { method: string; path: string; body: any }
type Item = { id: string; text: string; urgent?: boolean }

function setup(opts: { env?: Record<string, string>; pending?: () => Item[]; fail?: (c: Call) => boolean; reply?: (c: Call) => unknown; manifest?: () => any; toolsVersion?: () => string } = {}) {
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
      const r = opts.reply?.(c)
      if (r !== undefined) return ok(r)
      if (u.pathname === '/api/agent/tools') return ok(opts.manifest ? opts.manifest() : MANIFEST)
      if (u.pathname === '/api/agent/heartbeat') return ok({ ok: true, protocol: 1, tools_version: opts.toolsVersion ? opts.toolsVersion() : MANIFEST.version })
      if (u.pathname === '/api/agent/pending' && init.method === 'GET') return ok({ protocol: 1, items: (opts.pending ? opts.pending() : []).filter((p) => !done.has(p.id)), joiner: '\n---\n' })
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
      if (u.pathname === '/api/agent/tool') return ok(c.body.args?.fail ? { ok: false, error: 'body is required.' } : { ok: true, text: `RESULT ${c.body.tool}` })
      return ok({ ok: true })
    },
  }
  const ext = install(pi, deps)
  const ctx = (idle: () => boolean) => ({ sessionManager: { getSessionId: () => 'conv-1', getSessionFile: () => '/s/a_conv-1.jsonl' }, isIdle: idle })
  const events = () => calls.filter((c) => c.path === '/api/agent/event').map((c) => c.body)
  return { handlers, tools, sent, calls, order, ext, ctx, events, advance: (ms: number) => (clock += ms), setSendThrows: (v: boolean) => (sendThrows = v) }
}

const settle = () => new Promise((r) => setTimeout(r, 30))

test('does nothing without the minbox environment', () => {
  const t = setup({ env: {} })
  assert.equal(t.ext, null)
  assert.equal(t.tools.size, 0)
  assert.equal(t.handlers.size, 0)
})

test("session_start says hello (protocol 1) and registers the server's tools as served", async () => {
  const t = setup()
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  const hello = t.calls.find((c) => c.path === '/api/agent/hello')!
  assert.deepEqual([hello.body.agent, hello.body.agent_session_id, hello.body.session_file, hello.body.protocol], ['pi', 'conv-1', '/s/a_conv-1.jsonl', 1])
  assert.deepEqual([...t.tools.keys()], MANIFEST.tools.map((x: any) => x.name))
  const send = t.tools.get('minbox_send_message')
  assert.equal(send.label, 'minbox: send message')
  assert.deepEqual(send.parameters.required, ['body'])
  assert.equal(send.parameters.additionalProperties, true, 'the schema stays open: Pi validates against it')
  assert.match(t.tools.get('minbox_create_task').description, /minbox_update_task/)
  t.ext!.stop()
})

test("a tool call goes to the server with its arguments; its text is the result, a failure throws the server's words", async () => {
  const t = setup({ fail: (c) => c.path === '/api/agent/tool' && c.body.args?.down })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  const send = t.tools.get('minbox_send_message')
  const r = await send.execute('1', { body: 'hi', task_id: 'tsk_1' })
  assert.equal(r.content[0].text, 'RESULT minbox_send_message')
  assert.deepEqual(t.calls.find((c) => c.path === '/api/agent/tool')!.body, { tool: 'minbox_send_message', args: { body: 'hi', task_id: 'tsk_1' } })
  // An argument the registered schema does not declare is passed on as given.
  await send.execute('1', { body: 'hi', later_param: { x: 1 } })
  assert.deepEqual(t.calls.filter((c) => c.path === '/api/agent/tool').at(-1)!.body.args, { body: 'hi', later_param: { x: 1 } })
  await assert.rejects(send.execute('1', { fail: true }), /^Error: body is required\.$/)
  await assert.rejects(send.execute('1', { down: true }), /minbox: boom/)
  t.ext!.stop()
})

test("the server's guards block bash commands that open a page on the host", async () => {
  const t = setup()
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  const h = t.handlers.get('tool_call')!
  const blocked = await h({ toolName: 'bash', input: { command: 'gh pr view --web' } })
  assert.equal(blocked.block, true)
  assert.equal(blocked.reason, MANIFEST.guards[0].deny)
  // Accepting a pairing is the person's alone.
  const pair = await h({ toolName: 'bash', input: { command: 'cd /tmp && ./bin/minbox pair accept 482-913' } })
  assert.equal(pair.block, true)
  assert.match(pair.reason, /minbox pair accept/)
  assert.equal(await h({ toolName: 'bash', input: { command: 'minbox pair list' } }), undefined)
  assert.equal(await h({ toolName: 'bash', input: { command: 'ls -la' } }), undefined)
  assert.equal(await h({ toolName: 'read', input: { path: 'a' } }), undefined)
  t.ext!.stop()
})

test('agent_start and agent_settled go to the server as turn events', async () => {
  const t = setup()
  await t.handlers.get('agent_start')!({})
  await t.handlers.get('agent_start')!({}) // already busy: not again
  await t.handlers.get('agent_settled')!({ aborted: false })
  await settle()
  assert.deepEqual(t.events().map((e) => e.type), ['turn.start', 'turn.complete'])
  t.ext!.stop()
})

test("delivery waits for quiet, then sends the server's text and marks it delivered", async () => {
  let pending: Item[] = [{ id: 'm1', text: 'WAKE 1' }, { id: 'm2', text: 'WAKE 2' }]
  const t = setup({ pending: () => pending })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  await settle()
  assert.equal(t.sent.length, 0, 'not quiet yet: nothing is claimed')
  assert.equal(t.calls.some((c) => c.path.includes('/claim')), false)
  assert.ok(t.calls.find((c) => c.path.startsWith('/api/agent/pending?'))!.path.includes('proto=1'))
  t.advance(5000)
  await settle()
  assert.deepEqual(t.sent, [{ text: 'WAKE 1\n---\nWAKE 2', opts: undefined }])
  assert.deepEqual(t.order.slice(0, 3), ['send', 'delivered', 'delivered'])
  t.ext!.stop()
  pending = []
})

test('a busy Pi takes only urgent messages, as steering; a failed delivery is released', async () => {
  let pending: Item[] = [
    { id: 'w', text: 'wait' },
    { id: 'u', text: 'now', urgent: true },
  ]
  const t = setup({ pending: () => pending })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => false))
  await t.handlers.get('agent_start')!({})
  await settle()
  assert.ok(t.sent.length >= 1)
  assert.deepEqual(t.sent[0], { text: 'now', opts: { deliverAs: 'steer' } })
  t.ext!.stop()
  pending = []
  await settle()

  const t2 = setup({ pending: () => [{ id: 'u', text: 'now', urgent: true }] })
  t2.setSendThrows(true)
  await t2.handlers.get('session_start')!({ reason: 'startup' }, t2.ctx(() => true))
  await settle()
  assert.ok(t2.order.includes('release'))
  assert.equal(t2.order.includes('delivered'), false)
  t2.ext!.stop()
})

test('a busy turn with no event for 120 s is given up on, unless a subagent or a tool update shows life', async () => {
  const last = (t: ReturnType<typeof setup>) => t.events().filter((e) => e.type.startsWith('turn.')).at(-1)?.type
  const a = setup()
  await a.handlers.get('session_start')!({ reason: 'startup' }, a.ctx(() => false))
  await a.handlers.get('agent_start')!({})
  a.advance(130_000)
  await settle()
  assert.equal(last(a), 'turn.complete')
  a.ext!.stop()

  const { touchBusy } = await import('./busy.ts')
  const b = setup()
  await b.handlers.get('session_start')!({ reason: 'startup' }, b.ctx(() => false))
  await b.handlers.get('agent_start')!({})
  await settle()
  b.advance(130_000)
  touchBusy()
  await settle()
  assert.equal(last(b), 'turn.start')
  b.ext!.stop()

  const c = setup()
  await c.handlers.get('session_start')!({ reason: 'startup' }, c.ctx(() => false))
  await c.handlers.get('agent_start')!({})
  await settle()
  c.advance(130_000)
  await c.handlers.get('tool_execution_update')!({})
  await settle()
  assert.equal(last(c), 'turn.start')
  c.ext!.stop()
})

test('a heartbeat carries state, protocol and its own events; a new tools_version registers the set again', async () => {
  let version = MANIFEST.version
  let manifest = MANIFEST
  const t = setup({ fail: (c) => c.path === '/api/agent/title', toolsVersion: () => version, manifest: () => manifest })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  await settle()
  const beats = () => t.calls.filter((c) => c.path === '/api/agent/heartbeat')
  assert.equal(beats().length, 1)
  assert.deepEqual([beats()[0]!.body.seq, beats()[0]!.body.agent, beats()[0]!.body.state, beats()[0]!.body.protocol], [1, 'pi', 'idle', 1])
  // The server changed its tool set: one tool more, one fewer.
  manifest = { ...MANIFEST, version: 'v2', tools: [...MANIFEST.tools.filter((x: any) => x.name !== 'minbox_search'), { name: 'minbox_new', description: 'NEW', input_schema: { type: 'object' } }] }
  version = 'v2'
  t.advance(16_000)
  await settle()
  assert.equal(t.tools.get('minbox_new').description, 'NEW')
  assert.equal(t.tools.get('minbox_search').exposure, 'hidden')
  assert.equal(t.calls.filter((c) => c.path === '/api/agent/tools').length, 2)
  t.ext!.stop()
})

test('bash calls are not reported to the server', async () => {
  const t = setup()
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  await t.handlers.get('tool_execution_start')!({ toolCallId: 'c1', toolName: 'bash', args: { command: 'npm publish' } })
  assert.equal(t.handlers.get('tool_execution_end'), undefined)
  await settle()
  assert.deepEqual(t.events().filter((e) => e.type === 'bash'), [])
  t.ext!.stop()
})

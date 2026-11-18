// Tests of the OpenCode plugin as a proxy (mod protocol 1) against a fake OpenCode plugin context and
// a scripted minbox server serving the real tool set (plugin/testdata/manifest-opencode.json, kept
// equal to the server's by TestManifestFixtures). The wording is the server's and is tested there.
// Run: node --test plugin/opencode/*.test.ts   (Node 22.18+ strips the types itself)
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCore, majorVersion, setupLocation, type Deps } from './minbox.ts'
import entry from './index.ts'

const MANIFEST = JSON.parse(readFileSync(new URL('../testdata/manifest-opencode.json', import.meta.url), 'utf8'))

type Call = { method: string; path: string; body: any }
type Item = { id: string; text: string; urgent?: boolean }

const SES = 'ses_0123456789abcdefghijABCDEF'

/** A fake OpenCode 2.x plugin context: records tools, hooks, session calls; events are pushed by the test. */
function fakeCtx(opts: { version?: string; sessions?: Record<string, any>; promptThrows?: () => boolean } = {}) {
  const tools = new Map<string, any>()
  const hooks = new Map<string, Function>()
  const sessionCalls: { op: string; arg: any }[] = []
  const sessions: Record<string, any> = opts.sessions ?? { [SES]: { id: SES, location: { directory: '/work/a' } } }
  const queue: any[] = []
  let wake: (() => void) | null = null
  // Like OpenCode's tool state: the transform callbacks run again from scratch on reload().
  const transforms = new Set<(e: any) => void>()
  const rebuild = () => {
    tools.clear()
    for (const f of transforms) f({ add: (t: any) => tools.set(t.name, t) })
  }
  let reloads = 0
  const ctx = {
    app: { name: 'opencode', version: opts.version ?? '2.1.4', channel: 'latest' },
    location: { directory: '/work/a' },
    tool: {
      transform: async (f: (e: any) => void) => {
        transforms.add(f)
        rebuild()
        return { dispose: () => (transforms.delete(f), rebuild()) }
      },
      reload: async () => {
        reloads++
        rebuild()
      },
      hook: async (name: string, h: Function) => void hooks.set('tool.' + name, h),
    },
    permission: { hook: async (name: string, h: Function) => void hooks.set('permission.' + name, h) },
    session: {
      hook: async (name: string, h: Function) => void hooks.set('session.' + name, h),
      get: async (a: any) => {
        sessionCalls.push({ op: 'get', arg: a })
        const s = sessions[a.sessionID]
        if (!s) throw Object.assign(new Error('Session.NotFoundError'), { _tag: 'Session.NotFoundError' })
        return s
      },
      create: async (a: any) => {
        sessionCalls.push({ op: 'create', arg: a })
        sessions[a.id] = { id: a.id, location: a.location }
        return sessions[a.id]
      },
      move: async (a: any) => void sessionCalls.push({ op: 'move', arg: a }),
      update: async (a: any) => void sessionCalls.push({ op: 'update', arg: a }),
      prompt: async (a: any) => {
        if (opts.promptThrows?.()) throw new Error('Session.BusyError')
        sessionCalls.push({ op: 'prompt', arg: a })
        return { id: 'msg_1' }
      },
    },
    event: {
      subscribe: ({ signal }: { types?: string[]; signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length) yield queue.shift()
            else await new Promise<void>((r) => ((wake = r), setTimeout(r, 20)))
          }
        },
      }),
    },
  }
  const emit = (type: string, sessionID = SES) => {
    queue.push({ type, data: { sessionID } })
    wake?.()
  }
  return { ctx, tools, hooks, sessionCalls, sessions, emit, reloads: () => reloads }
}

function setup(opts: { env?: Record<string, string>; pending?: () => Item[]; fail?: (c: Call) => boolean; ctx?: Parameters<typeof fakeCtx>[0]; manifest?: () => any; toolsVersion?: () => string; tool?: (b: any) => any } = {}) {
  const calls: Call[] = []
  let clock = 1_000_000
  const done = new Set<string>()
  const deps: Deps = {
    env: opts.env ?? { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: '/srv.json', MINBOX_OPENCODE_SESSION: SES, MINBOX_OPENCODE_DIR: '/work/a' },
    readFile: () => JSON.stringify({ url: 'http://127.0.0.1:1' }),
    realpath: (p) => p,
    now: () => clock,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    randomId: () => 'owner1',
    fetch: async (url, init) => {
      const u = new URL(url)
      const c: Call = { method: init.method, path: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined }
      calls.push(c)
      if (opts.fail?.(c)) return { ok: false, status: 500, text: async () => '{"error":"boom"}' }
      const ok = (v: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) })
      if (u.pathname === '/api/agent/tools') return ok(opts.manifest ? opts.manifest() : MANIFEST)
      if (u.pathname === '/api/agent/hello') return ok({ session_id: 's1', agent: 'opencode', instructions: 'MINBOX-INSTRUCTIONS', protocol: 1 })
      if (u.pathname === '/api/agent/heartbeat') return ok({ ok: true, protocol: 1, tools_version: opts.toolsVersion ? opts.toolsVersion() : MANIFEST.version })
      if (u.pathname === '/api/agent/pending' && init.method === 'GET') return ok({ protocol: 1, items: (opts.pending ? opts.pending() : []).filter((p) => !done.has(p.id)), joiner: '\n---\n' })
      if (u.pathname.endsWith('/claim')) return ok({ claimed: true })
      if (u.pathname.endsWith('/delivered')) {
        done.add(decodeURIComponent(u.pathname.split('/').slice(-2)[0]))
        return ok({ ok: true })
      }
      if (u.pathname === '/api/agent/tool') return ok(opts.tool ? opts.tool(c.body) : { ok: true, text: `RESULT ${c.body.tool}` })
      return ok({ ok: true })
    },
  }
  const core = createCore(deps)
  const oc = fakeCtx(opts.ctx)
  // Stop the loop and unsubscribe at the end of the test.
  const orig = oc.ctx.event.subscribe
  const acs: AbortController[] = []
  oc.ctx.event.subscribe = (o: any) => {
    const ac = new AbortController()
    acs.push(ac)
    o.signal.addEventListener('abort', () => ac.abort())
    return orig({ ...o, signal: ac.signal })
  }
  running.push(() => {
    core.stop()
    for (const ac of acs) ac.abort()
  })
  const events = () => calls.filter((c) => c.path === '/api/agent/event').map((c) => c.body)
  return { core, oc, calls, events, advance: (ms: number) => (clock += ms) }
}

/** Everything a test started: stopped after it, so the event loop empties and node exits. */
const running: (() => void)[] = []
afterEach(() => {
  for (const f of running.splice(0)) f()
})

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))

test('does nothing without the minbox environment', async () => {
  const t = setup({ env: {} })
  const cleanup = await setupLocation(t.oc.ctx, t.core)
  assert.equal(cleanup, undefined)
  assert.equal(t.oc.tools.size, 0)
  assert.equal(t.calls.length, 0)
})

test('does nothing on OpenCode 1.x (or an unknown version), with a clear log line', async () => {
  const t = setup({ ctx: { version: '1.0.150' } })
  const logs: string[] = []
  assert.equal(await setupLocation(t.oc.ctx, t.core, (m) => logs.push(m)), undefined)
  assert.equal(t.oc.tools.size, 0)
  assert.match(logs[0], /not supported/)
  assert.equal(majorVersion('2.1.4'), 2)
  assert.equal(majorVersion('v3.0.0'), 3)
  assert.equal(majorVersion(undefined), 0)
})

test("registers the server's tools as direct tools, as served", async () => {
  const t = setup()
  const cleanup = await setupLocation(t.oc.ctx, t.core)
  assert.deepEqual([...t.oc.tools.keys()], MANIFEST.tools.map((x: any) => x.name))
  for (const tool of t.oc.tools.values()) assert.deepEqual(tool.options, { codemode: false }, tool.name)
  assert.deepEqual(t.oc.tools.get('minbox_send_message').input.required, ['body'])
  assert.match(t.oc.tools.get('minbox_update_task').description, /minbox_send_message/)
  t.core.stop()
  cleanup?.()
  assert.equal(t.oc.tools.size, 0, 'cleanup disposes the registration')
})

test("a new tools_version in the heartbeat's answer reloads the tool set", async () => {
  let version = MANIFEST.version
  let manifest = MANIFEST
  const t = setup({ toolsVersion: () => version, manifest: () => manifest })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  assert.equal(t.oc.tools.has('minbox_new'), false)
  manifest = { ...MANIFEST, version: 'v2', tools: [...MANIFEST.tools.filter((x: any) => x.name !== 'minbox_search'), { name: 'minbox_new', description: 'NEW', input_schema: { type: 'object' } }] }
  version = 'v2'
  t.advance(16_000)
  await settle(80)
  assert.equal(t.oc.reloads(), 1)
  assert.equal(t.oc.tools.get('minbox_new').description, 'NEW')
  assert.equal(t.oc.tools.has('minbox_search'), false)
  assert.equal(t.core.state().toolsVersion, 'v2')
})

test('the hello (protocol 1) reports the session; its instructions go into the system prompt of that session only', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  const hello = t.calls.find((c) => c.path === '/api/agent/hello')!
  assert.deepEqual([hello.body.agent, hello.body.agent_session_id, hello.body.opencode_version, hello.body.protocol], ['opencode', SES, '2.1.4', 1])
  const ctxHook = t.oc.hooks.get('session.context')!
  const mine = { sessionID: SES, system: [] as any[] }
  ctxHook(mine)
  assert.deepEqual(mine.system, [{ type: 'text', text: 'MINBOX-INSTRUCTIONS' }])
  const child = { sessionID: 'ses_child', system: [] as any[] }
  ctxHook(child)
  assert.deepEqual(child.system, [], 'a subagent child session gets no minbox instructions')
})

test('creates a missing session, and moves one that is in another folder', async () => {
  const t = setup({ ctx: { sessions: {} } })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  assert.deepEqual(t.oc.sessionCalls.find((c) => c.op === 'create')?.arg, { id: SES, location: { directory: '/work/a' } })
  t.core.stop()

  const m = setup({ ctx: { sessions: { [SES]: { id: SES, location: { directory: '/old/place' } } } } })
  await setupLocation(m.oc.ctx, m.core)
  await settle()
  assert.deepEqual(m.oc.sessionCalls.find((c) => c.op === 'move')?.arg, { sessionID: SES, directory: '/work/a' })
})

test('execution events of the minbox session only go to the server as turn events', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  t.oc.emit('session.execution.started', 'ses_other')
  await settle()
  assert.equal(t.core.state().busy, false)
  t.oc.emit('session.execution.started')
  await settle()
  assert.equal(t.core.state().busy, true)
  t.oc.emit('session.execution.interrupted')
  await settle()
  assert.equal(t.core.state().busy, false)
  assert.deepEqual(t.events().map((e) => e.type).slice(-2), ['turn.start', 'turn.complete'])
})

test("delivers the server's text into a quiet session with ctx.session.prompt and marks it delivered", async () => {
  let pending: Item[] = [{ id: 'msg_1', text: 'WAKE 1' }, { id: 'msg_2', text: 'WAKE 2' }]
  const t = setup({ pending: () => pending })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  t.advance(5000)
  await settle(120)
  const p = t.oc.sessionCalls.find((c) => c.op === 'prompt')
  assert.deepEqual(p?.arg, { sessionID: SES, text: 'WAKE 1\n---\nWAKE 2', delivery: 'steer', metadata: { minbox: true } })
  assert.ok(t.calls.some((c) => c.path.startsWith('/api/agent/pending/msg_1/delivered')))
  assert.ok(t.calls.some((c) => c.path.startsWith('/api/agent/pending?') && c.path.includes('proto=1')))
  pending = []
})

test('while busy only an urgent message goes in (steered); a failed prompt releases the claim', async () => {
  let pending: Item[] = [
    { id: 'msg_a', text: 'later' },
    { id: 'msg_b', text: 'now', urgent: true },
  ]
  const t = setup({ pending: () => pending })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  t.oc.emit('session.execution.started')
  await settle(120)
  const prompts = t.oc.sessionCalls.filter((c) => c.op === 'prompt')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].arg.text, 'now')
  t.core.stop()
  pending = []

  let throws = true
  const f = setup({ pending: () => [{ id: 'msg_x', text: 'x', urgent: true }], ctx: { promptThrows: () => throws } })
  await setupLocation(f.oc.ctx, f.core)
  await settle(100)
  assert.ok(f.calls.some((c) => c.path.startsWith('/api/agent/pending/msg_x/release')), 'released')
  assert.ok(!f.calls.some((c) => c.path.startsWith('/api/agent/pending/msg_x/delivered')))
  throws = false
})

test('the person submitting in the TUI holds deliveries back; a new top-level session is followed', async () => {
  const t = setup({ ctx: { sessions: { [SES]: { id: SES, location: { directory: '/work/a' } }, ses_new: { id: 'ses_new' }, ses_kid: { id: 'ses_kid', parentID: SES } } } })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  const prompt = t.oc.hooks.get('session.prompt')!
  await prompt({ sessionID: SES, metadata: {} })
  assert.ok(t.core.state().typedAt > 0)
  await prompt({ sessionID: 'ses_kid', metadata: {} })
  assert.equal(t.core.state().sessionID, SES, 'a subagent child is not followed')
  await prompt({ sessionID: 'ses_new', metadata: { minbox: true } })
  assert.equal(t.core.state().sessionID, SES, 'our own delivery is not the person')
  await prompt({ sessionID: 'ses_new', metadata: {} })
  assert.equal(t.core.state().sessionID, 'ses_new')
  const hellos = t.calls.filter((c) => c.path === '/api/agent/hello')
  assert.equal(hellos[hellos.length - 1].body.agent_session_id, 'ses_new')
})

test("the permission hook applies the server's guards: pages opened on the host, TUI questions in the main session", async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  const perm = t.oc.hooks.get('permission.evaluate')!
  const open = { sessionID: SES, action: 'shell', resources: ['open https://example.com'], effect: 'allow' as string, message: undefined as string | undefined }
  perm(open)
  assert.equal(open.effect, 'deny')
  assert.equal(open.message, MANIFEST.guards[0].deny)
  const ls = { sessionID: SES, action: 'shell', resources: ['ls -la'], effect: 'allow' }
  perm(ls)
  assert.equal(ls.effect, 'allow')
  const q = { sessionID: SES, action: 'question', resources: ['*'], effect: 'ask' as string, message: '' }
  perm(q)
  assert.equal(q.effect, 'deny')
  assert.match(q.message, /minbox_send_message/)
  const childQ = { sessionID: 'ses_child', action: 'question', resources: ['*'], effect: 'ask' }
  perm(childQ)
  assert.equal(childQ.effect, 'ask')
})

test("a tool call goes to the server; its text is the result, a failure throws, a title effect renames the OpenCode session", async () => {
  const t = setup({
    fail: (c) => c.path === '/api/agent/tool' && c.body.tool === 'minbox_open_url',
    tool: (b) => (b.tool === 'minbox_set_session_title' ? { ok: true, text: 'Session title set: New title', effects: { session_title: 'New title' } } : b.args.body === ' ' ? { ok: false, error: 'body is required.' } : { ok: true, text: 'Sent.' }),
  })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  const send = t.oc.tools.get('minbox_send_message')
  await assert.rejects(send.execute({ body: ' ' }), /^Error: body is required\.$/)
  const r = await send.execute({ body: 'Done', task_id: 'tsk_1' })
  assert.deepEqual(r, { content: 'Sent.' })
  assert.deepEqual(t.calls.filter((c) => c.path === '/api/agent/tool').at(-1)!.body, { tool: 'minbox_send_message', args: { body: 'Done', task_id: 'tsk_1' } })
  const title = await t.oc.tools.get('minbox_set_session_title').execute({ title: 'New title' })
  assert.equal(title.content, 'Session title set: New title')
  assert.deepEqual(t.oc.sessionCalls.find((c) => c.op === 'update')?.arg, { sessionID: SES, title: 'New title' })
  await assert.rejects(t.oc.tools.get('minbox_open_url').execute({ url: 'https://x' }), /minbox: boom/)
})

test('the heartbeat carries agent opencode and the protocol', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  await settle(60)
  const hb = t.calls.find((c) => c.path === '/api/agent/heartbeat')!
  assert.deepEqual([hb.body.agent, hb.body.seq, hb.body.protocol, hb.body.info.opencode_version], ['opencode', 1, 1, '2.1.4'])
  assert.ok(Array.isArray(hb.body.events))
})

test('shell outcomes go to the server: rejections with their reason, successes; other tools not', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  const ev = (type: string, data: object) => t.core.onEvent({ type, data: { sessionID: SES, ...data } })
  ev('session.tool.input.started', { id: 'call_1', name: 'bash' })
  ev('session.tool.called', { id: 'call_1', input: { command: 'git push origin main' } })
  ev('session.tool.failed', { id: 'call_1', error: { type: 'permission.rejected', message: 'a rule prevents it' } })
  ev('session.tool.input.started', { id: 'call_2', name: 'edit' })
  ev('session.tool.called', { id: 'call_2', input: { filePath: '/etc/hosts' } })
  ev('session.tool.failed', { id: 'call_2', error: { type: 'permission.rejected', message: 'no' } })
  ev('session.tool.input.started', { id: 'call_3', name: 'bash' })
  ev('session.tool.called', { id: 'call_3', input: { command: 'git push origin main' } })
  ev('session.tool.success', { id: 'call_3', content: [] })
  await settle()
  assert.deepEqual(
    t.events().filter((e) => e.type === 'bash'),
    [
      { type: 'bash', phase: 'failed', id: 'call_1', command: 'git push origin main', error_type: 'permission.rejected', message: 'a rule prevents it' },
      { type: 'bash', phase: 'success', id: 'call_3', command: 'git push origin main' },
    ],
  )
})

test('the entry is a plain V2 plugin object', () => {
  assert.equal(entry.id, 'minbox')
  assert.equal(typeof entry.setup, 'function')
})

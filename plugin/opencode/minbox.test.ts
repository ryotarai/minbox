// Tests of the OpenCode plugin against a fake OpenCode plugin context and a scripted minbox server.
// Run: node --test plugin/opencode/*.test.ts   (Node 22.18+ strips the types itself)
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createCore, majorVersion, setupLocation, TOOL_PREFIX, type Deps } from './minbox.ts'
import entry from './index.ts'

type Call = { method: string; path: string; body: any }

const SES = 'ses_0123456789abcdefghijABCDEF'

/** A fake OpenCode 2.x plugin context: records tools, hooks, session calls; events are pushed by the test. */
function fakeCtx(opts: { version?: string; sessions?: Record<string, any>; promptThrows?: () => boolean } = {}) {
  const tools = new Map<string, any>()
  const hooks = new Map<string, Function>()
  const sessionCalls: { op: string; arg: any }[] = []
  const sessions: Record<string, any> = opts.sessions ?? { [SES]: { id: SES, location: { directory: '/work/a' } } }
  const queue: any[] = []
  let wake: (() => void) | null = null
  const ctx = {
    app: { name: 'opencode', version: opts.version ?? '2.1.4', channel: 'latest' },
    location: { directory: '/work/a' },
    tool: {
      transform: async (f: (e: any) => void) => {
        f({ add: (t: any) => tools.set(t.name, t) })
        return { dispose: () => tools.clear() }
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
  return { ctx, tools, hooks, sessionCalls, sessions, emit }
}

function setup(opts: { env?: Record<string, string>; pending?: () => any[]; fail?: (c: Call) => boolean; ctx?: Parameters<typeof fakeCtx>[0] } = {}) {
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
      if (u.pathname === '/api/agent/hello') return ok({ session_id: 's1', agent: 'opencode', instructions: 'MINBOX-INSTRUCTIONS' })
      if (u.pathname === '/api/agent/pending' && init.method === 'GET') return ok((opts.pending ? opts.pending() : []).filter((p: any) => !done.has(p.id)))
      if (u.pathname.endsWith('/claim')) return ok({ claimed: true })
      if (u.pathname.endsWith('/delivered')) {
        done.add(decodeURIComponent(u.pathname.split('/').slice(-2)[0]))
        return ok({ ok: true })
      }
      if (u.pathname === '/api/agent/messages') return ok({ thread_id: 'thr_1', new_thread: true })
      if (u.pathname === '/api/agent/title') return ok({ ok: true, title: 'T' })
      if (u.pathname === '/api/agent/tasks' && init.method === 'POST') return ok({ id: 'tpc_1', thread_id: c.body.thread_id, status: 'in_progress', title: c.body.title, summary: '', tasks: c.body.steps ?? [] })
      if (u.pathname.startsWith('/api/agent/tasks/')) return ok({ id: 'tpc_1', thread_id: 'thr_1', status: c.body.status, title: 'Search UI', summary: '', tasks: [] })
      if (u.pathname === '/api/agent/tasks') return ok({ threads: [] })
      return ok({})
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
  return { core, oc, calls, advance: (ms: number) => (clock += ms) }
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

test('registers the minbox tools as direct tools under OpenCode names', async () => {
  const t = setup()
  const cleanup = await setupLocation(t.oc.ctx, t.core)
  for (const n of ['send_message', 'read_thread', 'set_session_title', 'open_url', 'list_projects', 'get_project', 'list_sessions', 'list_threads', 'search']) {
    const tool = t.oc.tools.get(TOOL_PREFIX + n)
    assert.ok(tool, n)
    assert.deepEqual(tool.options, { codemode: false }, n)
    assert.equal(typeof tool.input, 'object')
  }
  assert.deepEqual(t.oc.tools.get('minbox_send_message').input.required, ['body'])
  assert.match(t.oc.tools.get('minbox_read_thread').description, /minbox_read_thread|thread/)
  t.core.stop()
  cleanup?.()
  assert.equal(t.oc.tools.size, 0, 'cleanup disposes the registration')
})

test('the hello reports the session; its instructions go into the system prompt of that session only', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  const hello = t.calls.find((c) => c.path === '/api/agent/hello')!
  assert.equal(hello.body.agent, 'opencode')
  assert.equal(hello.body.agent_session_id, SES)
  assert.equal(hello.body.opencode_version, '2.1.4')
  const ctxHook = t.oc.hooks.get('session.context')!
  const mine = { sessionID: SES, system: [] as any[] }
  ctxHook(mine)
  assert.deepEqual(mine.system, [{ type: 'text', text: 'MINBOX-INSTRUCTIONS' }])
  const child = { sessionID: 'ses_child', system: [] as any[] }
  ctxHook(child)
  assert.deepEqual(child.system, [], 'a subagent child session gets no minbox instructions')
  t.core.stop()
})

test('creates a missing session, and moves one that is in another folder', async () => {
  const t = setup({ ctx: { sessions: {} } })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  const create = t.oc.sessionCalls.find((c) => c.op === 'create')
  assert.deepEqual(create?.arg, { id: SES, location: { directory: '/work/a' } })
  t.core.stop()

  const m = setup({ ctx: { sessions: { [SES]: { id: SES, location: { directory: '/old/place' } } } } })
  await setupLocation(m.oc.ctx, m.core)
  await settle()
  assert.deepEqual(m.oc.sessionCalls.find((c) => c.op === 'move')?.arg, { sessionID: SES, directory: '/work/a' })
  m.core.stop()
})

test('execution events set working / idle for the minbox session only', async () => {
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
  const statuses = t.calls.filter((c) => c.path === '/api/agent/status').map((c) => c.body.status)
  assert.deepEqual(statuses.slice(-2), ['working', 'idle'])
  t.core.stop()
})

test('delivers into a quiet session with ctx.session.prompt and marks it delivered', async () => {
  let pending = [{ id: 'msg_1', thread_id: 'thr_1', subject: 'Hi', body: 'Please fix it', urgent: false }]
  const t = setup({ pending: () => pending })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  t.advance(5000)
  await settle(120)
  const p = t.oc.sessionCalls.find((c) => c.op === 'prompt')
  assert.ok(p, 'prompted')
  assert.equal(p!.arg.sessionID, SES)
  assert.deepEqual(p!.arg.metadata, { minbox: true })
  assert.match(p!.arg.text, /minbox inbox: Hi \(thread_id: thr_1\)/)
  assert.match(p!.arg.text, /minbox_send_message/)
  assert.ok(t.calls.some((c) => c.path.startsWith('/api/agent/pending/msg_1/delivered')))
  pending = []
  t.core.stop()
})

test('while busy only an urgent message goes in (steered); a failed prompt releases the claim', async () => {
  let pending: any[] = [
    { id: 'msg_a', thread_id: 'thr_1', subject: 'A', body: 'later', urgent: false },
    { id: 'msg_b', thread_id: 'thr_2', subject: 'B', body: 'now', urgent: true },
  ]
  const t = setup({ pending: () => pending })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  t.oc.emit('session.execution.started')
  await settle(120)
  const prompts = t.oc.sessionCalls.filter((c) => c.op === 'prompt')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].arg.delivery, 'steer')
  assert.match(prompts[0].arg.text, /thr_2/)
  assert.doesNotMatch(prompts[0].arg.text, /thr_1/)
  t.core.stop()

  let throws = true
  const f = setup({ pending: () => [{ id: 'msg_x', thread_id: 'thr_1', subject: 'X', body: 'b', urgent: true }], ctx: { promptThrows: () => throws } })
  await setupLocation(f.oc.ctx, f.core)
  await settle(100)
  assert.ok(f.calls.some((c) => c.path.startsWith('/api/agent/pending/msg_x/release')), 'released')
  assert.ok(!f.calls.some((c) => c.path.startsWith('/api/agent/pending/msg_x/delivered')))
  throws = false
  f.core.stop()
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
  t.core.stop()
})

test('the permission hook denies opening pages on the host and TUI questions in the main session', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  const perm = t.oc.hooks.get('permission.evaluate')!
  const open = { sessionID: SES, action: 'shell', resources: ['open https://example.com'], effect: 'allow' as string, message: undefined as string | undefined }
  perm(open)
  assert.equal(open.effect, 'deny')
  assert.match(open.message!, /minbox_open_url/)
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
  t.core.stop()
})

test('tools call the minbox API; the title also renames the OpenCode session', async () => {
  const t = setup({ fail: (c) => c.path === '/api/agent/open' })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  const send = t.oc.tools.get('minbox_send_message')
  await assert.rejects(send.execute({ body: ' ' }), /body is required/)
  const r = await send.execute({ body: 'Done', status: 'done', task_ids: ['tsk_1'], thread_id: 'thr_1' })
  assert.equal(typeof r.content, 'string')
  const msg = t.calls.find((c) => c.path === '/api/agent/messages')!
  assert.equal(msg.body.thread_id, 'thr_1')
  assert.equal(msg.body.status, 'done')
  assert.deepEqual(msg.body.task_ids, ['tsk_1'])
  await t.oc.tools.get('minbox_set_session_title').execute({ title: 'New title' })
  assert.deepEqual(t.oc.sessionCalls.find((c) => c.op === 'update')?.arg, { sessionID: SES, title: 'New title' })
  await assert.rejects(t.oc.tools.get('minbox_open_url').execute({ url: 'https://x' }), /minbox: boom/)
  t.core.stop()
})

test('task tools create, update and list tasks on the agent API', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  for (const n of ['create_task', 'update_task', 'list_tasks']) assert.ok(t.oc.tools.has('minbox_' + n), n)
  assert.match(t.oc.tools.get('minbox_update_task').description, /minbox_send_message/)
  await assert.rejects(t.oc.tools.get('minbox_create_task').execute({}), /title is required/)
  const r = await t.oc.tools.get('minbox_create_task').execute({ title: 'Search UI', status: 'needs_you', kind: 'goal', criteria: [{ text: 'CI green' }] })
  assert.deepEqual(t.calls.at(-1)!.body, { title: 'Search UI', kind: 'goal', status: 'needs_you', criteria: [{ text: 'CI green', done: false }] })
  assert.match(r.content, /task_id tpc_1/)
  await t.oc.tools.get('minbox_update_task').execute({ task_id: 'tpc_1', status: 'done' })
  assert.deepEqual([t.calls.at(-1)!.method, t.calls.at(-1)!.path], ['PATCH', '/api/agent/tasks/tpc_1'])
  const l = await t.oc.tools.get('minbox_list_tasks').execute({})
  assert.equal(l.content, 'No tasks yet.')
  t.core.stop()
})

test('the heartbeat speaks the shared protocol with agent opencode', async () => {
  const t = setup()
  await setupLocation(t.oc.ctx, t.core)
  await settle(60)
  const hb = t.calls.find((c) => c.path === '/api/agent/heartbeat')
  assert.ok(hb)
  assert.equal(hb!.body.agent, 'opencode')
  assert.equal(hb!.body.seq, 1)
  assert.ok(['idle', 'working'].includes(hb!.body.state))
  assert.equal(hb!.body.info.opencode_version, '2.1.4')
  assert.ok(Array.isArray(hb!.body.events))
  t.core.stop()
})

test('a shell call whose permission was rejected is reported with its thread; a later success clears it', async () => {
  let pending = [{ id: 'msg_1', thread_id: 'thr_7', subject: 'Deploy', body: 'ship it', urgent: false }]
  const t = setup({ pending: () => pending })
  await setupLocation(t.oc.ctx, t.core)
  await settle()
  t.advance(5000)
  await settle(120)
  pending = []
  assert.ok(t.oc.sessionCalls.some((c) => c.op === 'prompt'), 'delivered')
  const ev = (type: string, data: object) => t.core.onEvent({ type, data: { sessionID: SES, assistantMessageID: 'msg_a', ...data } })
  ev('session.execution.started', {})
  const reports = () => t.calls.filter((c) => c.path === '/api/agent/denied-commands')
  const ran = () => t.calls.filter((c) => c.path === '/api/agent/denied-commands/ran')

  // Fixture: a config `deny` rule on `git push *` (OpenCode's events for it).
  ev('session.tool.input.started', { id: 'call_1', name: 'bash' })
  ev('session.tool.called', { id: 'call_1', input: { command: 'git push origin main', description: 'push' }, executed: false })
  ev('session.tool.failed', { id: 'call_1', error: { type: 'permission.rejected', message: 'The user has specified a rule which prevents you from using this specific tool call.' }, executed: false })
  await settle()
  assert.equal(reports().length, 1)
  assert.deepEqual([reports()[0].body.command, reports()[0].body.thread_id], ['git push origin main', 'thr_7'])
  assert.match(reports()[0].body.reason, /rule which prevents/)

  // A command that failed on its own, another tool, minbox's own refusal: not reported.
  ev('session.tool.input.started', { id: 'call_2', name: 'bash' })
  ev('session.tool.called', { id: 'call_2', input: { command: 'false' } })
  ev('session.tool.failed', { id: 'call_2', error: { type: 'tool.execution', message: 'exit 1' } })
  ev('session.tool.input.started', { id: 'call_3', name: 'edit' })
  ev('session.tool.called', { id: 'call_3', input: { filePath: '/etc/hosts' } })
  ev('session.tool.failed', { id: 'call_3', error: { type: 'permission.rejected', message: 'no' } })
  const ownDeny = (await import('../minbox/hooks/text.ts')).openDeny('minbox_open_url')
  ev('session.tool.input.started', { id: 'call_4', name: 'bash' })
  ev('session.tool.called', { id: 'call_4', input: { command: 'open https://example.com' } })
  ev('session.tool.failed', { id: 'call_4', error: { type: 'permission.rejected', message: ownDeny } })
  await settle()
  assert.equal(reports().length, 1)

  // The same command succeeds later: cleared once.
  for (const id of ['call_5', 'call_6']) {
    ev('session.tool.input.started', { id, name: 'bash' })
    ev('session.tool.called', { id, input: { command: 'git push origin main' } })
    ev('session.tool.success', { id, content: [], executed: true })
  }
  await settle()
  assert.equal(ran().length, 1)
  assert.deepEqual(ran()[0].body, { command: 'git push origin main' })

  // After the execution ends, a rejection has no thread (the server gives it the next message's).
  ev('session.execution.succeeded', {})
  ev('session.tool.called', { id: 'call_7', input: { command: 'rm -rf dist' } })
  ev('session.tool.failed', { id: 'call_7', error: { type: 'permission.rejected', message: 'denied' } })
  await settle()
  assert.equal(reports().length, 2)
  assert.equal(reports()[1].body.thread_id, undefined)
  t.core.stop()
})

test('the entry is a plain V2 plugin object', () => {
  assert.equal(entry.id, 'minbox')
  assert.equal(typeof entry.setup, 'function')
})

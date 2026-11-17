// Tests of the Pi extension against a mock of Pi's ExtensionAPI and a scripted minbox server.
// Run: node --test plugin/pi/minbox.test.ts   (Node 22.18+ strips the types itself)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { install, TOOL_PREFIX, type Deps } from './minbox.ts'

type Call = { method: string; path: string; body: any }

function setup(opts: { env?: Record<string, string>; pending?: () => any[]; fail?: (c: Call) => boolean; reply?: (c: Call) => unknown } = {}) {
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
      const r = opts.reply?.(c)
      if (r !== undefined) return ok(r)
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
  for (const n of ['send_message', 'read_thread', 'set_session_title', 'open_url', 'list_projects', 'get_project', 'list_sessions', 'list_threads', 'search']) assert.ok(t.tools.has(TOOL_PREFIX + n), n)
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

test('navigation tools are read-only GETs on the agent API, with filters passed through', async () => {
  const t = setup({
    reply: (c) =>
      c.path.startsWith('/api/agent/projects') && !c.path.includes('/projects/')
        ? [{ id: 'prj_1', name: 'minbox', dir: '/w/minbox', host_name: 'local', default_agent: 'pi', session_count: 2, live_sessions: 1, thread_count: 3, need_action: 1, unread: 2, last_activity: '2026-11-10T01:02:03Z' }]
        : c.path.startsWith('/api/agent/inbox')
          ? { threads: [{ id: 'thr_9', subject: 'Plan', status: 'need_action', project_name: 'minbox', session_name: 's', open_questions: 1, unread: 1, message_count: 4, last_author: 'agent', updated_at: '2026-11-10T01:02:03Z', last_body: 'A or B?' }], total: 7, has_more: true }
          : c.path.startsWith('/api/agent/search')
            ? { threads: [], messages: [{ thread_id: 'thr_9', subject: 'Plan', session_name: 's', author: 'user', snippet: 'the zeppelin', created_at: '2026-11-10T01:02:03Z' }], files: [] }
            : undefined,
  })
  const projects = await t.tools.get('minbox_list_projects').execute('1', {})
  assert.match(projects.content[0].text, /prj_1 "minbox" · \/w\/minbox on local · default agent pi · 2 sessions \(1 live\)/)
  const threads = await t.tools.get('minbox_list_threads').execute('1', { project_id: 'prj_1', awaiting: 'person', unread: true, query: 'plan b', limit: 5, archived: false })
  const call = t.calls.find((c) => c.path.startsWith('/api/agent/inbox'))!
  assert.equal(call.method, 'GET')
  assert.equal(call.path, '/api/agent/inbox?project_id=prj_1&awaiting=person&unread=1&q=plan+b&limit=5')
  assert.match(threads.content[0].text, /thr_9 "Plan" · need_action · minbox \/ s · 1 open question · 1 unread/)
  assert.match(threads.content[0].text, /\(1 of 7 threads shown/)
  const found = await t.tools.get('minbox_search').execute('1', { query: 'zeppelin', from: 'person', session_id: 'self' })
  assert.equal(t.calls.at(-1)!.path, '/api/agent/search?q=zeppelin&session_id=self&from=user')
  assert.match(found.content[0].text, /thread thr_9 "Plan" \(session s\) · person 2026-11-10 01:02: the zeppelin/)
  await t.tools.get('minbox_get_project').execute('1', { project_id: 'a/b' })
  assert.equal(t.calls.at(-1)!.path, '/api/agent/projects/a%2Fb')
  await t.tools.get('minbox_list_sessions').execute('1', { status: 'idle', agent: 'pi' })
  assert.equal(t.calls.at(-1)!.path, '/api/agent/sessions?status=idle&agent=pi')
  await assert.rejects(t.tools.get('minbox_search').execute('1', { query: ' ' }), /query is required/)
  await assert.rejects(t.tools.get('minbox_get_project').execute('1', {}), /project_id is required/)
  assert.ok(t.calls.every((c) => c.method === 'GET' || !c.path.startsWith('/api/agent/') || ['/api/agent/hello', '/api/agent/status'].includes(c.path)))
  assert.match(t.tools.get('minbox_list_threads').description, /minbox_read_thread/)
  t.ext!.stop()
})

test('read_thread pages: limit and before are passed on, the answer says what is missing', async () => {
  const msgs = [1, 2].map((i) => ({ id: `msg_${i}`, author: i === 1 ? 'user' : 'agent', body: `body ${i}`, created_at: `t${i}` }))
  const t = setup({
    reply: (c) =>
      c.path.startsWith('/api/agent/threads/')
        ? { id: 'thr_5', subject: 'Long', status: 'working', project_name: 'minbox', session_name: 'other', own: false, open_questions: 0, message_count: 40, has_more: true, older: 38, next_before: 'msg_1', messages: msgs }
        : c.path === '/api/agent/threads'
          ? []
          : undefined,
  })
  const r = await t.tools.get('minbox_read_thread').execute('1', { thread_id: 'thr_5', limit: 2, before: 'msg_9' })
  assert.equal(t.calls.at(-1)!.path, '/api/agent/threads/thr_5?limit=2&before=msg_9')
  const text = r.content[0].text
  assert.match(text, /Showing the newest 2 of 40 messages; 38 older ones are not shown\. For them call minbox_read_thread with this thread_id and before "msg_1"/)
  assert.match(text, /session other \(not yours\)/)
  assert.match(text, /\[agent · t2 · msg_2\]\nbody 2/)
  await t.tools.get('minbox_read_thread').execute('1', {})
  assert.equal(t.calls.at(-1)!.path, '/api/agent/threads')
  t.ext!.stop()
})

test('a heartbeat goes out with the loop (every 15 s) carrying state, version and its own events', async () => {
  const t = setup({ fail: (c) => c.path === '/api/agent/title' })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  await settle()
  const beats = () => t.calls.filter((c) => c.path === '/api/agent/heartbeat')
  assert.equal(beats().length, 1)
  assert.deepEqual([beats()[0]!.body.seq, beats()[0]!.body.agent, beats()[0]!.body.state], [1, 'pi', 'idle'])
  assert.equal(typeof beats()[0]!.body.ext_version, 'string')
  await t.tools.get('minbox_set_session_title').execute('1', { title: 'T' }).catch(() => {})
  t.advance(16_000)
  await settle()
  assert.equal(beats().length >= 2, true)
  const last = beats().pop()!
  assert.equal(last.body.seq >= 2, true)
  assert.match(JSON.stringify(last.body.events), /api-error/)
  t.ext!.stop()
})

test('a bash call another extension blocked is reported with its thread; a later run clears it', async () => {
  let pending: any[] = [{ id: 'm1', thread_id: 'thr_9', subject: 'Re: deploy', body: 'go', new_thread: false, urgent: true }]
  const t = setup({ pending: () => pending })
  await t.handlers.get('session_start')!({ reason: 'startup' }, t.ctx(() => true))
  await settle()
  pending = []
  assert.equal(t.sent.length, 1, 'the message in thr_9 is delivered')
  await t.handlers.get('agent_start')!({})
  const start = t.handlers.get('tool_execution_start')!
  const end = t.handlers.get('tool_execution_end')!
  const text = (s: string) => ({ content: [{ type: 'text', text: s }] })
  const reports = () => t.calls.filter((c) => c.path === '/api/agent/denied-commands')
  const ran = () => t.calls.filter((c) => c.path === '/api/agent/denied-commands/ran')

  // Blocked by another extension: ended in error, never ran (no durationMs).
  await start({ toolCallId: 'c1', toolName: 'bash', args: { command: ' npm publish ' } })
  await end({ toolCallId: 'c1', toolName: 'bash', isError: true, result: text('Blocked by permission-gate: publishing needs approval') })
  await settle()
  assert.equal(reports().length, 1)
  assert.deepEqual([reports()[0].body.command, reports()[0].body.reason, reports()[0].body.thread_id], ['npm publish', 'Blocked by permission-gate: publishing needs approval', 'thr_9'])

  // A command that ran and failed, an abort, bad arguments: not denials.
  await start({ toolCallId: 'c2', toolName: 'bash', args: { command: 'false' } })
  await end({ toolCallId: 'c2', toolName: 'bash', isError: true, durationMs: 3, result: text('exit code 1') })
  await start({ toolCallId: 'c3', toolName: 'bash', args: { command: 'sleep 100' } })
  await end({ toolCallId: 'c3', toolName: 'bash', isError: true, result: text('Operation aborted') })
  // The extension's own refusal (a page opened on the host) is not reported either.
  await t.handlers.get('tool_call')!({ toolCallId: 'c4', toolName: 'bash', input: { command: 'open https://example.com' } })
  await start({ toolCallId: 'c4', toolName: 'bash', args: { command: 'open https://example.com' } })
  await end({ toolCallId: 'c4', toolName: 'bash', isError: true, result: text('minbox: this would open the page on the host machine') })
  await settle()
  assert.equal(reports().length, 1)

  // The denied command runs later (allowed this time): cleared once.
  await start({ toolCallId: 'c5', toolName: 'bash', args: { command: 'npm publish' } })
  await end({ toolCallId: 'c5', toolName: 'bash', isError: false, durationMs: 900, result: text('published') })
  await start({ toolCallId: 'c6', toolName: 'bash', args: { command: 'npm publish' } })
  await end({ toolCallId: 'c6', toolName: 'bash', isError: false, durationMs: 900, result: text('published') })
  await settle()
  assert.equal(ran().length, 1)
  assert.deepEqual(ran()[0].body, { command: 'npm publish' })

  // After the turn, a block has no thread (the server gives it the agent's next message's).
  await t.handlers.get('agent_settled')!({})
  await start({ toolCallId: 'c7', toolName: 'bash', args: { command: 'rm -rf dist' } })
  await end({ toolCallId: 'c7', toolName: 'bash', isError: true, result: text('blocked') })
  await settle()
  assert.equal(reports().length, 2)
  assert.equal(reports()[1].body.thread_id, undefined)
  t.ext!.stop()
})

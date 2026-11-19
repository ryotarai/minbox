// The Claude Code mod as a proxy (mod protocol 1): it registers the server's tools, passes calls,
// events and deliveries through, and keeps the connection healthy. The wording it passes on is the
// server's and is tested there (internal/server/modtext_test.go, modproto_test.go).
import { expect, mock, test } from 'claude-code/testing'

const SERVER_FILE = '/data/server.json'

type Call = { method: string; path: string; query: string; body: any }

const OPEN_DENY = 'minbox: this would open the page on the host machine (server text).'

/** A small tool set as the server would serve it (the real one: plugin/testdata/manifest-claude.json). */
function manifest(version = 'v1', extra: any[] = []) {
  return {
    protocol: 1,
    version,
    tools: [
      { name: 'send_message', description: 'SEND-DESC', input_schema: { type: 'object', properties: { body: { type: 'string' } } }, deferred: false },
      { name: 'list_threads', description: 'NAV-DESC', input_schema: { type: 'object' }, deferred: true },
      ...extra,
    ],
    guards: [{ tools: ['Bash'], patterns: ['(?:^|[;&|(`]|\\$\\()\\s*open\\s+https?:\\/\\/'], deny: OPEN_DENY }],
  }
}

type Item = { id: string; text: string; urgent?: boolean }

/** A minbox server in memory: answers the mod's HTTP calls. */
function fakeServer(on: any, pending: Item[], opts: { hangPolls?: number; down?: boolean; failPaths?: RegExp; id?: { current: string }; manifest?: any; toolsVersion?: { current: string }; event?: (b: any) => any; tool?: (b: any) => any } = {}) {
  const calls: Call[] = []
  const submitted: string[] = []
  const delivered = new Set<string>()
  const claimed = new Set<string>()
  const registered: Record<string, any> = {}
  const registrations: string[] = []
  const invalidated: string[] = []
  on('fs.read', (_: any, e: any) => ({ value: e.path === SERVER_FILE ? JSON.stringify({ url: 'http://127.0.0.1:4848' }) : null }))
  on('session.id', () => ({ value: opts.id?.current ?? 'claude-1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId ?? 't' }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer ?? '' }))
  on('tool.register', (_: any, e: any) => {
    registered[e.name] = e
    registrations.push(e.name)
    return { value: { tool: `mcp__minbox__${e.name}` } }
  })
  on('ui.invalidate', (_: any, e: any) => {
    invalidated.push(e.event)
    return { value: undefined }
  })
  on('tool.describe', (_: any, e: any) => ({ description: e.description }))
  on('http.fetch', (_: any, e: any) => {
    const url = new URL(e.url)
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    const method = e.init?.method ?? 'GET'
    calls.push({ method, path: url.pathname, query: url.search, body })
    if (opts.down || (opts.failPaths && opts.failPaths.test(url.pathname))) return { value: { status: 503, ok: false, headers: {}, text: '{"error":"down"}' } }
    const ok = (json: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(json) } })
    if (url.pathname === '/api/agent/tools') return ok(opts.manifest ?? manifest())
    if (url.pathname === '/api/agent/pending') {
      if (opts.hangPolls && opts.hangPolls > 0) {
        opts.hangPolls--
        return new Promise(() => {}) // a connection that never answers
      }
      return ok({ protocol: 1, items: pending.filter((p) => !claimed.has(p.id) && !delivered.has(p.id)), joiner: '\n---\n' })
    }
    const m = url.pathname.match(/^\/api\/agent\/pending\/([^/]+)\/(claim|release|delivered)$/)
    if (m) {
      if (m[2] === 'claim') {
        const fresh = !claimed.has(m[1]!)
        claimed.add(m[1]!)
        return ok({ claimed: fresh })
      }
      if (m[2] === 'release') claimed.delete(m[1]!)
      if (m[2] === 'delivered') delivered.add(m[1]!)
      return ok({ ok: true })
    }
    if (url.pathname === '/api/agent/hello') return ok({ session_id: 's', protocol: 1, tools_version: opts.toolsVersion?.current ?? 'v1' })
    if (url.pathname === '/api/agent/heartbeat') return ok({ ok: true, protocol: 1, tools_version: opts.toolsVersion?.current ?? 'v1' })
    if (url.pathname === '/api/agent/event') return ok(opts.event?.(body) ?? { ok: true })
    if (url.pathname === '/api/agent/tool') return ok(opts.tool?.(body) ?? { ok: true, text: `RESULT ${body.tool}` })
    return ok({ ok: true })
  })
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  const events = () => calls.filter((c) => c.path === '/api/agent/event').map((c) => c.body)
  return { calls, submitted, delivered, registered, registrations, invalidated, events, releaseAll: () => claimed.clear() }
}

const REPLY: Item = { id: 'msg_r1', text: 'SERVER WAKE TEXT 1' }
const start = async ($: any) => $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

test('outside minbox nothing is registered and nothing is called', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const server = fakeServer(on, [REPLY])
  await start($)
  expect(server.calls.length).toBe(0)
  expect(Object.keys(server.registered)).toEqual([])
})

test("the server's tools are registered as served, deferred or not", async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await start($)
  expect(server.registered.send_message).toEqual({ name: 'send_message', description: 'SEND-DESC', inputSchema: { type: 'object', properties: { body: { type: 'string' } } }, isDeferred: false })
  expect(server.registered.list_threads.isDeferred).toBe(true)
})

test('a tool call goes to the server with its arguments; its text is the result, a failure the refusal', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [], { tool: (b) => (b.args.body ? { ok: true, text: 'Sent to the person.' } : { ok: false, error: 'body is required.' }) })
  await start($)
  const res: any = await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi', task_id: 't1' } as any)
  expect(res.result).toBe('Sent to the person.')
  expect(server.calls.find((c) => c.path === '/api/agent/tool')?.body).toEqual({ tool: 'send_message', args: { body: 'hi', task_id: 't1' } })
  // Arguments the conversation's schema may not list (added later) go to the server as given; only the host's own keys are dropped.
  await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi', commands: [{ command: 'make' }], later_param: { x: 1 }, tool_use_id: 'tu9' } as any)
  expect(server.calls.filter((c) => c.path === '/api/agent/tool').pop()?.body).toEqual({ tool: 'send_message', args: { body: 'hi', commands: [{ command: 'make' }], later_param: { x: 1 } } })
  const bad: any = await $.tool.call({ tool: 'mcp__minbox__send_message', body: '' } as any)
  expect(bad.deny).toBe('body is required.')
})

test('a tool call the server cannot answer is refused with the HTTP failure', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [], { failPaths: /\/api\/agent\/tool$/ })
  await start($)
  const res: any = await $.tool.call({ tool: 'mcp__minbox__list_threads' } as any)
  expect(res.deny).toBe('minbox: down')
})

test("a new tools_version in the heartbeat's answer registers the tool set again", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const opts: any = { toolsVersion: { current: 'v1' } }
  const server = fakeServer(on, [], opts)
  await start($)
  await clock.advance(1000)
  expect(server.registered.new_tool).toBeUndefined()
  opts.manifest = manifest('v2', [{ name: 'new_tool', description: 'NEW', input_schema: { type: 'object' } }])
  opts.toolsVersion.current = 'v2'
  await clock.advance(15000)
  expect(server.registered.new_tool?.description).toBe('NEW')
  const res: any = await $.tool.call({ tool: 'mcp__minbox__new_tool', x: 1 } as any)
  expect(res.result).toBe('RESULT new_tool')
  const beat = server.calls.filter((c) => c.path === '/api/agent/heartbeat').pop()!
  await clock.advance(15000)
  expect(server.calls.filter((c) => c.path === '/api/agent/tools').length).toBe(2) // not again for the same version
  expect(beat.body.protocol).toBe(1)
})

/** Raises tool.describe for a minbox tool as Claude Code does, with the description it registered. */
const describe = ($: any, server: { registered: Record<string, any> }, name: string) =>
  $.tool.describe({ tool: `mcp__minbox__${name}`, description: server.registered[name].description, provider: { plugin: 'minbox', tier: 'user' } })

/** Starts a session, then serves the tool set `next` under v2 and lets the heartbeat fetch it. */
async function refreshTo($: any, on: any, next: any) {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const opts: any = { toolsVersion: { current: 'v1' } }
  const server = fakeServer(on, [], opts)
  await start($)
  await clock.advance(1000)
  const atStart = server.registrations.length
  opts.manifest = next
  opts.toolsVersion.current = 'v2'
  await clock.advance(15000)
  expect(server.calls.filter((c) => c.path === '/api/agent/tools').length).toBe(2)
  return { server, again: server.registrations.slice(atStart) }
}

test('at session start no tool breaks the prompt cache and nothing is described again', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await start($)
  expect(server.registrations).toEqual(['send_message', 'list_threads'])
  expect(server.invalidated).toEqual([])
  for (const name of ['send_message', 'list_threads']) {
    const res: any = await describe($, server, name)
    expect(res.breakPromptCache).toBeUndefined()
    expect(res.description).toBe(server.registered[name].description)
  }
})

test('a refresh with one changed tool registers only that one and sends its new description over the cache', async ($, on) => {
  const next = manifest('v2')
  next.tools[0] = { ...next.tools[0]!, description: 'SEND-DESC-2', input_schema: { type: 'object', properties: { body: { type: 'string' }, commands: { type: 'array' } } } }
  const { server, again } = await refreshTo($, on, next)
  expect(again).toEqual(['send_message'])
  // The new schema is registered; the registered description stays the first one, so the new
  // text is the describe hook's own answer, which Claude Code sends over what a conversation sent.
  expect(server.registered.send_message.inputSchema.properties.commands).toEqual({ type: 'array' })
  expect(server.registered.send_message.description).toBe('SEND-DESC')
  expect(server.invalidated).toEqual(['tool.describe'])
  const changed: any = await describe($, server, 'send_message')
  expect(changed).toEqual({ description: 'SEND-DESC-2', breakPromptCache: true })
  const same: any = await describe($, server, 'list_threads')
  expect(same.breakPromptCache).toBeUndefined()
  expect(same.description).toBe('NAV-DESC')
})

test('a refresh to the same definitions under a new version registers nothing and breaks nothing', async ($, on) => {
  const { server, again } = await refreshTo($, on, manifest('v2'))
  expect(again).toEqual([])
  expect(server.invalidated).toEqual([])
  for (const name of ['send_message', 'list_threads']) expect(((await describe($, server, name)) as any).breakPromptCache).toBeUndefined()
})

test('a changed schema alone is registered but asks for no description again', async ($, on) => {
  const next = manifest('v2')
  next.tools[1] = { ...next.tools[1]!, input_schema: { type: 'object', properties: { q: { type: 'string' } } } }
  const { server, again } = await refreshTo($, on, next)
  expect(again).toEqual(['list_threads'])
  expect(server.invalidated).toEqual([])
  expect(((await describe($, server, 'list_threads')) as any).breakPromptCache).toBeUndefined()
})

test('a description changed back to the first one is answered plainly again', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const opts: any = { toolsVersion: { current: 'v1' } }
  const server = fakeServer(on, [], opts)
  await start($)
  const v2 = manifest('v2')
  v2.tools[0] = { ...v2.tools[0]!, description: 'SEND-DESC-2' }
  opts.manifest = v2
  opts.toolsVersion.current = 'v2'
  await clock.advance(15000)
  expect(((await describe($, server, 'send_message')) as any).breakPromptCache).toBe(true)
  opts.manifest = manifest('v3')
  opts.toolsVersion.current = 'v3'
  await clock.advance(15000)
  const res: any = await describe($, server, 'send_message')
  expect(res.description).toBe('SEND-DESC')
  expect(res.breakPromptCache).toBeUndefined()
})

test("the server's text is delivered once Claude is idle, then acknowledged", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY, { id: 'msg_r2', text: 'SERVER WAKE TEXT 2' }])
  await start($)
  await clock.advance(5000)
  expect(server.submitted).toEqual(['SERVER WAKE TEXT 1\n---\nSERVER WAKE TEXT 2'])
  expect([...server.delivered]).toEqual(['msg_r1', 'msg_r2'])
  const poll = server.calls.find((c) => c.path === '/api/agent/pending')!
  expect(poll.query).toContain('proto=1')
  expect(server.calls.find((c) => c.path === '/api/agent/hello')?.body).toEqual({ claude_session_id: 'claude-1', agent: 'claude', ext_version: '0.2.0', protocol: 1 })
  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
})

test('while Claude works a message waits (turn events go to the server); an urgent one goes in', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const pending: Item[] = [REPLY]
  const server = fakeServer(on, pending)
  await start($)
  await $.turn.start({ text: 'work', turnId: 't1' } as any)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(0)
  expect(server.events()).toContainEqual({ type: 'turn.start' })
  pending.push({ id: 'msg_u', text: 'URGENT', urgent: true })
  await clock.advance(3000)
  expect(server.submitted).toEqual(['URGENT'])
  await $.turn.complete({ answer: 'done', durationMs: 1, reason: 'answer', isAborted: false } as any)
  await clock.advance(5000)
  expect(server.submitted).toEqual(['URGENT', 'SERVER WAKE TEXT 1'])
  expect(server.events()).toContainEqual({ type: 'turn.complete', reason: 'answer', aborted: false, answer: 'done' })
})

test("each prompt asks the server for its context and adds what it answers", async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  let n = 0
  const server = fakeServer(on, [], { event: (b) => (b.type === 'prompt' ? { context: ++n === 1 ? ['STANDING', 'THREADS'] : [] } : { ok: true }) })
  await start($)
  const first: any = await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as any)
  expect(first.context).toEqual(['STANDING', 'THREADS'])
  const second: any = await $.prompt.submit({ text: 'again' })
  expect(second.context ?? []).toEqual([])
  expect(server.events().filter((e) => e.type === 'prompt')[0]).toEqual({ type: 'prompt', origin: 'composer' })
})

test('compaction and session.end are forwarded', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  on('session.compact', (_: any, e: any) => ({ messages: e.messages ?? [] }))
  on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
  await start($)
  await ($ as any).session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  await $.session.end({ reason: 'clear', sessionId: 'claude-1', resume: {} } as any)
  const types = server.events().map((e) => e.type)
  expect(types).toContain('session.compact')
  expect(types).toContain('session.end')
})

test('a turn that died on an API error forwards its class (StopFailure) as turn.error', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  on('classic.StopFailure', () => ({}))
  await start($)
  await ($ as any).classic.StopFailure({ error: 'model_not_found', error_details: 'model: claude-bogus' })
  await $.turn.complete({ turnId: 't1', answer: '', reason: 'error', isAborted: false, durationMs: 1 } as any)
  expect(server.events()).toContainEqual({ type: 'turn.error', error: 'model_not_found' })
  expect(server.events()).toContainEqual({ type: 'turn.complete', reason: 'error', aborted: false, answer: '' })
})

test("the server's reminder after a turn is submitted once idle, once; the person typing first drops it", async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [], { event: (b) => (b.type === 'turn.complete' ? { submit_when_idle: 'REMIND' } : { ok: true }) })
  await start($)
  await $.turn.start({ turnId: 't1' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'Should I?', reason: 'answer', isAborted: false, durationMs: 1 } as any)
  await clock.advance(5000)
  expect(server.submitted).toEqual(['REMIND'])
  await clock.advance(5000)
  expect(server.submitted).toEqual(['REMIND'])

  await $.turn.start({ turnId: 't2' } as any)
  await $.turn.complete({ turnId: 't2', answer: 'Should I?', reason: 'answer', isAborted: false, durationMs: 1 } as any)
  await $.prompt.submit({ text: 'no, do X', origin: { kind: 'composer' } } as any)
  await clock.advance(5000)
  expect(server.submitted.filter((t) => t === 'REMIND').length).toBe(1)
})

test("the server's guards refuse a Bash call; other calls run and nothing is reported", async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  let ran = ''
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => {
    ran = e.command
    return { result: 'ok' }
  })
  await start($)
  const denied: any = await $.tool.call({ tool: 'Bash', command: 'open https://github.com/o/r/pull/12' } as any)
  expect(denied.deny).toBe(OPEN_DENY)
  expect(ran).toBe('')
  await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'tu2' } as any)
  expect(ran).toBe('make')
  expect(server.events().filter((e) => e.type === 'bash')).toEqual([])
})

test('a heartbeat goes out at start and every 15 s, carrying the mod state and its own event log', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await start($)
  await clock.advance(1000)
  const beats = () => server.calls.filter((c) => c.path === '/api/agent/heartbeat')
  expect(beats().length).toBe(1)
  expect(beats()[0]!.body.seq).toBe(1)
  expect(beats()[0]!.body.state).toBe('idle')
  expect(beats()[0]!.body.agent).toBe('claude')
  expect(beats()[0]!.body.events.map((e: any) => e.kind)).toContain('hello')
  await $.turn.start({ turnId: 't1' } as any)
  await clock.advance(15000)
  expect(beats().length).toBe(2)
  expect(beats()[1]!.body.state).toBe('working')
  await clock.advance(30000)
  expect(beats().length).toBe(4)
})

test('a delivery shows in the next heartbeat and carries no message text', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])
  await start($)
  await clock.advance(20000)
  const last = server.calls.filter((c) => c.path === '/api/agent/heartbeat').pop()!
  expect(last.body.last_delivery_at).not.toBe('')
  expect(last.body.events.some((e: any) => e.kind === 'delivered' && e.msg.includes('msg_r1'))).toBe(true)
  expect(JSON.stringify(last.body)).not.toContain('SERVER WAKE TEXT')
})

test('a poll that never answers is abandoned, and the next one delivers', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY], { hangPolls: 1 })
  await start($)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(0)
  await clock.advance(40000) // past the call timeout
  expect(server.submitted.length).toBe(1)
})

test('a turn whose end was missed does not hold messages for ever', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])
  await start($)
  await $.turn.start({ turnId: 't1' } as any)
  await clock.advance(30000)
  expect(server.submitted.length).toBe(0)
  await clock.advance(120000)
  expect(server.submitted.length).toBe(1)
})

test('failed calls are recorded in the mod log, go offline with one toast, and come back with one', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => {
    toasts.push(String(e.message ?? e.text ?? JSON.stringify(e)))
    return { value: null }
  })
  const opts = { down: false }
  const server = fakeServer(on, [], opts)
  await start($)
  await clock.advance(2000)
  opts.down = true
  await clock.advance(40000)
  expect(toasts.filter((t) => t.includes('cannot reach')).length).toBe(1)
  opts.down = false
  await clock.advance(40000)
  expect(toasts.filter((t) => t.includes('connected to the server again')).length).toBe(1)
  const kinds = server.calls.filter((c) => c.path === '/api/agent/heartbeat').pop()!.body.events.map((e: any) => e.kind)
  expect(kinds).toContain('offline')
  expect(kinds).toContain('online')
})

test('when the delivered call fails the message is acknowledged again, never submitted twice', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const opts: any = { failPaths: /\/delivered$/ }
  const server = fakeServer(on, [REPLY], opts)
  await start($)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
  expect(server.delivered.size).toBe(0)
  opts.failPaths = undefined
  server.releaseAll()
  await clock.advance(30000)
  expect(server.submitted.length).toBe(1)
  expect([...server.delivered]).toEqual(['msg_r1'])
})

test('tools the server could not list at start are registered once it answers', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const opts: any = { failPaths: /\/api\/agent\/tools$/ }
  const server = fakeServer(on, [], opts)
  await start($)
  expect(server.registered.send_message).toBeUndefined()
  opts.failPaths = undefined
  await clock.advance(2000)
  expect(server.registered.send_message?.description).toBe('SEND-DESC')
})

for (const restart of [false, true]) {
  test(`/clear (session.end${restart ? ', then a session.start' : ', no start after'}): heartbeat and polling go on, hello is re-sent`, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
    const id = { current: 'claude-1' }
    const pending: Item[] = []
    const server = fakeServer(on, pending, { id })
    on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
    await start($)
    await clock.advance(5000)
    const hellos = () => server.calls.filter((c) => c.path === '/api/agent/hello')
    const beats = () => server.calls.filter((c) => c.path === '/api/agent/heartbeat').length
    expect(hellos().length).toBe(1)
    id.current = 'claude-2'
    await $.session.end({ reason: 'clear', sessionId: 'claude-1', resume: {} } as any)
    if (restart) await start($)
    const before = beats()
    await clock.advance(40_000)
    expect(beats()).toBeGreaterThan(before + 1)
    expect(hellos().at(-1)!.body.claude_session_id).toBe('claude-2')
    pending.push(REPLY)
    await clock.advance(5000)
    expect(server.submitted.length).toBe(1)
  })
}

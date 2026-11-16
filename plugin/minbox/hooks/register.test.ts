import { expect, mock, test } from 'claude-code/testing'
import { asksPerson, replyNudgeText, ATTACHMENTS_GUIDE, opensBrowser, SEND_DESCRIPTION, sentText, threadText } from './text'

const SERVER_FILE = '/data/server.json'

const registeredTools: Record<string, boolean> = {}

type Call = { method: string; path: string; body: any }

/** A minbox server in memory: answers the mod's HTTP calls. */
function fakeServer(on: any, pending: any[], opts: { instructions?: string; failHello?: boolean; hangPolls?: number; down?: boolean; failPaths?: RegExp; id?: { current: string } } = {}) {
  const calls: Call[] = []
  const submitted: string[] = []
  const delivered = new Set<string>()
  const claimed = new Set<string>()
  on('fs.read', (_: any, e: any) => ({ value: e.path === SERVER_FILE ? JSON.stringify({ url: 'http://127.0.0.1:4848' }) : null }))
  on('session.id', () => ({ value: opts.id?.current ?? 'claude-1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId ?? 't' }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer ?? '' }))
  on('tool.register', (_: any, e: any) => {
    registeredTools[e.name] = e.isDeferred
    return { value: { tool: `mcp__minbox__${e.name}` } }
  })
  on('http.fetch', (_: any, e: any) => {
    const url = new URL(e.url)
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    const method = e.init?.method ?? 'GET'
    calls.push({ method, path: url.pathname, body })
    if (opts.down || (opts.failPaths && opts.failPaths.test(url.pathname))) return { value: { status: 503, ok: false, headers: {}, text: '{"error":"down"}' } }
    const ok = (json: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(json) } })
    if (url.pathname === '/api/agent/pending') {
      if (opts.hangPolls && opts.hangPolls > 0) {
        opts.hangPolls--
        return new Promise(() => {}) // a connection that never answers
      }
      return ok(pending.filter((p) => !claimed.has(p.id) && !delivered.has(p.id)))
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
    if (url.pathname === '/api/agent/hello') {
      if (opts.failHello) return { value: { status: 500, ok: false, headers: {}, text: '{"error":"x"}' } }
      return ok({ session_id: 's', name: 'n', instructions: opts.instructions ?? '' })
    }
    if (url.pathname === '/api/agent/messages') {
      return ok({ thread_id: 'thr_1', message_id: 'msg_1', new_thread: true, questions: [{ key: 'q-1', kind: 'single', prompt: 'A or B?' }] })
    }
    if (url.pathname === '/api/agent/inbox') {
      return ok({ threads: [{ id: 'thr_9', subject: 'Plan', status: 'need_action', project_name: 'minbox', session_name: 's', open_questions: 0, unread: 0, message_count: 2, last_author: 'user', updated_at: '2026-11-10T01:02:03Z', last_body: 'go' }], total: 1, has_more: false })
    }
    if (url.pathname.startsWith('/api/agent/threads/')) {
      return ok({ id: 'thr_5', subject: 'Long', status: 'working', own: false, session_name: 'other', open_questions: 0, message_count: 40, has_more: true, older: 38, next_before: 'msg_1', messages: [{ id: 'msg_1', author: 'user', body: 'hello', created_at: 't1' }] })
    }
    if (url.pathname === '/api/agent/threads') {
      return ok([{ id: 'thr_1', subject: 'Plan', section: 'waiting', open_questions: 1, last_author: 'agent', last_body: 'A or B?' }])
    }
    return ok({ ok: true })
  })
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text, context: e.context }
  })
  return { calls, submitted, delivered, releaseAll: () => claimed.clear() }
}

const REPLY = {
  id: 'msg_r1',
  thread_id: 'thr_1',
  author: 'user',
  body: 'Answered 1 question.\n\n## Answers to your questions\n\n### Q1. A or B?\nAnswer: A',
  subject: 'Plan',
  new_thread: false,
  created_at: '2026-11-03T00:00:00Z',
}

test('a reply is delivered once Claude is idle, then acknowledged', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])

  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)

  expect(server.submitted.length).toBe(1)
  expect(server.submitted[0]).toContain('minbox inbox: Plan (thread_id: thr_1)')
  expect(server.submitted[0]).toContain('Answer: A')
  expect(server.submitted[0]).toContain('mcp__minbox__send_message with thread_id thr_1')
  expect(server.submitted[0].trimEnd().split('\n').pop()).toBe(
    '(Thread thr_1. Earlier messages in this thread: call mcp__minbox__read_thread with this thread_id.)',
  )
  expect([...server.delivered]).toEqual(['msg_r1'])
  // The hello carried the conversation id.
  expect(server.calls.find((c) => c.path === '/api/agent/hello')?.body).toEqual({ claude_session_id: 'claude-1' })

  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
})

test('each delivered message ends with a hint carrying its own thread id (new thread, urgent too)', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [{ ...REPLY, urgent: true }, { ...REPLY, id: 'msg_r2', thread_id: 'thr_7', new_thread: true, urgent: true }])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  const text = server.submitted[0]
  expect(text).toContain('(Thread thr_1. Earlier messages in this thread: call mcp__minbox__read_thread with this thread_id.)')
  expect(text).toContain('(Thread thr_7. Earlier messages in this thread: call mcp__minbox__read_thread with this thread_id.)')
})

test('send_message posts the message and says the reply comes by itself', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const res: any = await $.tool.call({ tool: 'mcp__minbox__send_message', status: 'working', body: ':::question\nA or B?\n- [ ] A\n- [ ] B\n:::', thread_title: 'Plan' })
  expect(res.result).toContain('Started thread thr_1')
  expect(res.result).toContain('Do not wait or poll')
  const post = server.calls.find((c) => c.path === '/api/agent/messages')
  expect(post?.body.thread_title).toBe('Plan')
})

test('send_message is refused without a valid status', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi' } as any)
  const bad: any = await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi', status: 'done' } as any)
  expect(JSON.stringify(res)).toContain('status is required')
  expect(JSON.stringify(bad)).toContain('status is required')
  expect(server.calls.filter((c) => c.path === '/api/agent/messages')).toHaveLength(0)
})

test('send_message is refused without a usable thread_title', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const send = (extra: object): Promise<any> => $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi', status: 'working', ...extra } as any)
  expect(JSON.stringify(await send({}))).toContain('thread_title is required')
  expect(JSON.stringify(await send({ thread_title: '   ' }))).toContain('thread_title is required')
  expect(server.calls.filter((c) => c.path === '/api/agent/messages')).toHaveLength(0)
})

test('send_message accepts a long thread_title in full (30 characters is only guidance)', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi', status: 'working', thread_title: 'x'.repeat(30) } as any)
  await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi', status: 'working', thread_title: 'あ'.repeat(100) } as any)
  const posts = server.calls.filter((c) => c.path === '/api/agent/messages')
  expect(posts).toHaveLength(2)
  expect(posts[1]?.body.thread_title).toBe('あ'.repeat(100))
})

test('send_message forwards status', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'done', status: 'finished', thread_title: 'T' } as any)
  await $.tool.call({ tool: 'mcp__minbox__send_message', status: 'need_action', body: 'more', thread_title: 'T' } as any)
  const posts = server.calls.filter((c) => c.path === '/api/agent/messages')
  expect(posts[0]?.body.status).toBe('finished')
  expect(posts[1]?.body.status).toBe('need_action')
})

test('send_message still forwards the old subject parameter as thread_title', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__minbox__send_message', status: 'working', body: 'hi', subject: 'Old' } as any)
  expect(server.calls.find((c) => c.path === '/api/agent/messages')?.body.thread_title).toBe('Old')
})

test('the first prompt carries the server instructions', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [], { instructions: 'SERVER-TEXT' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.prompt.submit({ text: 'hello' })
  expect(res.context).toHaveLength(1)
  expect(res.context[0]).toContain('minbox: standing instructions (still in force)')
  expect(res.context[0]).toContain('SERVER-TEXT')
})

test('without instructions from the hello the first prompt carries a short fallback', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [], { failHello: true })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.prompt.submit({ text: 'hello' })
  expect(res.context).toHaveLength(1)
  expect(res.context[0]).toContain('mcp__minbox__send_message')
  expect(res.context[0]).not.toContain('standing instructions')
})

test('after a compaction the instructions come back with the open threads, once', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE, MINBOX_ORCHESTRATOR_EVERY: '100' })
  fakeServer(on, [], { instructions: 'SERVER-TEXT' })
  on('session.compact', (_: any, e: any) => ({ messages: e.messages ?? [] }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'one' })
  const quiet: any = await $.prompt.submit({ text: 'two' })
  expect(quiet.context ?? []).toHaveLength(0)
  await ($ as any).session.compact({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
  const res: any = await $.prompt.submit({ text: 'three' })
  expect(res.context).toHaveLength(2)
  expect(res.context[0]).toContain('SERVER-TEXT')
  expect(res.context[1]).toContain('thr_1')
  const after: any = await $.prompt.submit({ text: 'four' })
  expect(after.context ?? []).toHaveLength(0)
})

test('outside minbox nothing is registered', async ($, on) => {
  mock.clock(on)
  mock.env(on, {})
  const server = fakeServer(on, [REPLY])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  expect(server.calls.length).toBe(0)
})

test('while Claude works, a reply waits; it goes once the turn ends', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 't1' } as any)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(0)
  expect(server.calls.some((c) => c.path === '/api/agent/status' && c.body.status === 'working')).toBe(true)

  await $.turn.complete({ answer: 'done', durationMs: 1, reason: 'answer' } as any)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
})

test('an urgent reply goes in even while Claude works', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [{ ...REPLY, urgent: true }])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'work', turnId: 't1' } as any)
  await clock.advance(3000)
  expect(server.submitted.length).toBe(1)
  expect([...server.delivered]).toEqual(['msg_r1'])
})

test('the orchestration prompt rides every Nth prompt, and only when set', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE, MINBOX_ORCHESTRATOR_EVERY: '3' })
  fakeServer(on, [], { instructions: 'ORCH-TEXT' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const has = async () => {
    const res: any = await $.prompt.submit({ text: 'p' })
    return (res.context?.join('\n') ?? '').includes('ORCH-TEXT')
  }
  expect([await has(), await has(), await has(), await has(), await has(), await has()]).toEqual([true, false, true, false, false, true])
})

test('the orchestration prompt defaults to every 20th prompt', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [], { instructions: 'ORCH-TEXT' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const seen: number[] = []
  for (let i = 1; i <= 20; i++) {
    const res: any = await $.prompt.submit({ text: 'p' })
    if ((res.context?.join('\n') ?? '').includes('ORCH-TEXT')) seen.push(i)
  }
  expect(seen).toEqual([1, 20])
})

test('the orchestration prompt rides the first prompt after the hello, once', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE, MINBOX_ORCHESTRATOR_EVERY: '100' })
  fakeServer(on, [], { instructions: 'ORCH-TEXT' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const has = async () => {
    const res: any = await $.prompt.submit({ text: 'p' })
    return (res.context?.join('\n') ?? '').includes('ORCH-TEXT')
  }
  expect([await has(), await has(), await has()]).toEqual([true, false, false])
})

test('a prompt never carries the instructions twice', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE, MINBOX_ORCHESTRATOR_EVERY: '1' })
  fakeServer(on, [], { instructions: 'ORCH-TEXT' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.prompt.submit({ text: 'p' })
  expect(res.context).toHaveLength(1)
})

test('empty instructions from the hello fall back to the short reminder', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE, MINBOX_ORCHESTRATOR_EVERY: '1' })
  fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.prompt.submit({ text: 'p' })
  expect((res.context?.join('\n') ?? '')).not.toContain('standing instructions')
})

test('send_message passes attachments and a review', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__minbox__send_message', status: 'working', body: 'see', thread_title: 'T', attachments: ['plan.md'], review: { title: 'R', sections: [{ title: 'a', files: ['a.go'] }] }, name: 'tag' } as any)
  const post = server.calls.find((c) => c.path === '/api/agent/messages')
  expect(post?.body.attachments).toEqual(['plan.md'])
  expect(post?.body.review.title).toBe('R')
  expect(post?.body.name).toBe('tag')
})

test('send_message tells Claude what it attached and which images will not show', () => {
  const text = sentText({
    thread_id: 'thr_9',
    new_thread: true,
    questions: [{ key: 'q-1', prompt: 'Go?' }],
    attachments: [{ id: 'att_1', name: 'plan.md', kind: 'markdown', path: '/w/plan.md' }],
    images_not_shown: [
      { ref: 'shots/x.png', reason: 'does not exist yet; it will show if it is written there later', not_yet: true },
      { ref: '~/.ssh/k.png', reason: 'a .env file, or in a hidden folder of the home folder such as ~/.ssh' },
    ],
  })
  expect(text).toContain('Sent to the minbox inbox asking 1 question with 1 attachment (Started thread thr_9).')
  expect(text).toContain('Attached: plan.md (markdown).')
  expect(text).toContain('This image does not exist yet: shots/x.png; it shows once written there.')
  expect(text).toContain('The message was sent, but this image will not show: ~/.ssh/k.png (a .env file, or in a hidden folder of the home folder such as ~/.ssh). Copy the image to a plain folder and link that path, or attach it with attachments.')
  expect(SEND_DESCRIPTION.length).toBeLessThan(2048)
  expect(ATTACHMENTS_GUIDE).toContain('Folders and .env files are refused.')
  const read = threadText({
    id: 'thr_9', subject: 'S', updated_at: '', unread: 0, open_questions: 0, section: 'quiet', last_body: '', last_author: 'user',
    messages: [{ id: 'm', thread_id: 'thr_9', author: 'user', body: 'see', created_at: 't', attachments: [{ id: 'a', name: 'n.png', type: 'image', kind: 'file', path: '/d/uploads/a/n.png' }] }],
  } as any)
  expect(read).toContain('Attached: n.png (/d/uploads/a/n.png) [image]')
})

test('set_session_title sets the title', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const res: any = await $.tool.call({ tool: 'mcp__minbox__set_session_title', title: '  Fix login redirect  ' } as any)
  const call = server.calls.find((c) => c.path === '/api/agent/title')
  expect(call?.body).toEqual({ title: 'Fix login redirect' })
  expect(JSON.stringify(res)).toContain('Session title set')
})

test('open_url opens the page in the browser; Bash opening it on the host is refused', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  let ran = ''
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => {
    ran = e.command
    return { result: 'ok' }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const res: any = await $.tool.call({ tool: 'mcp__minbox__open_url', url: 'https://github.com/o/r/pull/12' } as any)
  expect(server.calls.find((c) => c.path === '/api/agent/open')?.body).toEqual({ url: 'https://github.com/o/r/pull/12' })
  expect(JSON.stringify(res)).toContain("in the person's browser")

  const denied: any = await $.tool.call({ tool: 'Bash', command: 'open https://github.com/o/r/pull/12' } as any)
  expect(denied.deny).toContain('mcp__minbox__open_url')
  expect(ran).toBe('')
  await $.tool.call({ tool: 'Bash', command: 'gh pr view --json url -q .url' } as any)
  expect(ran).toBe('gh pr view --json url -q .url')
})

test('opensBrowser: commands that open a page on the host', () => {
  for (const c of [
    'open https://github.com/o/r/pull/1',
    "open 'https://x.dev'",
    'cd /w && open -a "Google Chrome" https://x.dev',
    'xdg-open http://localhost:3000',
    'gh pr view 12 --web',
    'gh pr create --fill -w',
    'gh browse',
    'gh run view 99 --web; echo done',
  ]) expect([c, opensBrowser(c)]).toEqual([c, true])
  for (const c of ['gh pr view --json url -q .url', 'open README.md', 'echo open https://x', 'git push -u origin main', 'grep -w open file', 'gh pr list --state open']) {
    expect([c, opensBrowser(c)]).toEqual([c, false])
  }
})

test('the mod no longer composes the system prompt: the server owns the text', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [])
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(composed.sections.map((s: any) => s.id)).toEqual(['intro'])
})

test('a turn that asks the person in the chat only is followed by one reminder to use the inbox', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const turn = async (answer: string, send = false) => {
    await $.turn.start({ turnId: 't', prompt: 'p' } as any)
    if (send) await $.tool.call({ tool: 'mcp__minbox__send_message', status: 'working', body: 'Which one?', subject: 'Pick' } as any)
    await $.turn.complete({ turnId: 't', answer, reason: 'answer', isAborted: false, durationMs: 1 } as any)
    await clock.advance(5000)
  }

  await turn('Done. マージしてもよろしいですか？')
  expect(server.submitted.length).toBe(1)
  expect(server.submitted[0]).toContain('Send it now with mcp__minbox__send_message')
  // The reminder's own turn never reminds again.
  await turn('Should I merge it?')
  expect(server.submitted.length).toBe(1)
  // Asked through the inbox: nothing to remind.
  await turn('I sent the question to your inbox. Which one?', true)
  expect(server.submitted.length).toBe(1)
  // A plain report: nothing either.
  await turn('All tests pass; the fix is in `a ? b : c`.')
  expect(server.submitted.length).toBe(1)
})

test('asksPerson reads the end of the answer', () => {
  for (const a of ['どちらにしますか？', 'Ready. Should I push?', 'Let me know if you want the other layout.', '確認してください。', 'Please review the diff.', '方針A/Bどちらで進めますか。'])
    expect([a, asksPerson(a)]).toEqual([a, true])
  for (const a of ['Fixed the bug; tests pass.', 'Uses `x ? y : z` now.', 'Opened https://x.dev/?q=1', '```\nconst a = b ? c : d\n```\nDone.'])
    expect([a, asksPerson(a)]).toEqual([a, false])
})

test('a poll that never answers is abandoned, and the next one delivers', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY], { hangPolls: 1 })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  expect(server.submitted.length).toBe(0)
  await clock.advance(40000) // past the call timeout
  expect(server.submitted.length).toBe(1)
  expect([...server.delivered]).toEqual(['msg_r1'])
})

test('a turn whose end was missed does not hold messages for ever', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 't1' } as any)
  await clock.advance(30000)
  expect(server.submitted.length).toBe(0) // working: the message waits
  await clock.advance(120000)
  expect(server.submitted.length).toBe(1)
})

test('a turn that answered an inbox message without send_message is reminded once to reply in that thread', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  expect(server.submitted.length).toBe(1) // the delivery

  // The delivered message's turn ends with a plain chat answer: one reminder naming the thread.
  await $.turn.start({ turnId: 't1', prompt: 'p' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'Done.', reason: 'answer', isAborted: false, durationMs: 1 } as any)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(2)
  expect(server.submitted[1]).toBe(replyNudgeText('mcp__minbox__send_message', ['thr_1']))
  expect(server.submitted[1]).toContain('thread_id thr_1')

  // The reminder's own turn does not remind again.
  await $.turn.start({ turnId: 't2', prompt: 'p' } as any)
  await $.turn.complete({ turnId: 't2', answer: 'Sent.', reason: 'answer', isAborted: false, durationMs: 1 } as any)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(2)
})

test('a turn that answered an inbox message with send_message is not reminded', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
  await $.turn.start({ turnId: 't1', prompt: 'p' } as any)
  await $.tool.call({ tool: 'mcp__minbox__send_message', status: 'working', body: 'Done', thread_title: 'T', thread_id: 'thr_1' } as any)
  await $.turn.complete({ turnId: 't1', answer: 'Done.', reason: 'answer', isAborted: false, durationMs: 1 } as any)
  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
})

test('navigation tools are registered (deferred) and answer from the read-only API', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  for (const n of ['list_projects', 'get_project', 'list_sessions', 'list_threads', 'search']) expect([n, registeredTools[n]]).toEqual([n, true])

  const res: any = await $.tool.call({ tool: 'mcp__minbox__list_threads', status: 'need_action', awaiting: 'person', query: 'plan' } as any)
  expect(server.calls.find((c) => c.path === '/api/agent/inbox')).toBeTruthy()
  expect(JSON.stringify(res)).toContain('thr_9 \\"Plan\\" · need_action · minbox / s')
  const bad: any = await $.tool.call({ tool: 'mcp__minbox__search', query: '' } as any)
  expect(bad.deny).toContain('query is required')
})

test('read_thread pages through any thread and says what is missing', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.tool.call({ tool: 'mcp__minbox__read_thread', thread_id: 'thr_5', limit: 1 } as any)
  const text = JSON.stringify(res)
  expect(text).toContain('Showing the newest 1 of 40 messages; 38 older ones are not shown.')
  expect(text).toContain('mcp__minbox__read_thread with this thread_id and before \\"msg_1\\"')
  expect(text).toContain('session other (not yours)')
})

test('a heartbeat goes out at start and every 15 s, carrying the mod state and its own event log', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(1000)
  const beats = () => server.calls.filter((c) => c.path === '/api/agent/heartbeat')
  expect(beats().length).toBe(1)
  expect(beats()[0]!.body.seq).toBe(1)
  expect(beats()[0]!.body.state).toBe('idle')
  expect(beats()[0]!.body.agent).toBe('claude')
  expect(typeof beats()[0]!.body.ext_version).toBe('string')
  expect(beats()[0]!.body.events.map((e: any) => e.kind)).toContain('hello')
  await $.turn.start({ turnId: 't1' } as any)
  await clock.advance(15000)
  expect(beats().length).toBe(2)
  expect(beats()[1]!.body.seq).toBe(2)
  expect(beats()[1]!.body.state).toBe('working')
  await clock.advance(30000)
  expect(beats().length).toBe(4)
})

test('a delivery shows in the next heartbeat (last_delivery_at, an event) and carries no message text', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [REPLY])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(20000)
  const last = server.calls.filter((c) => c.path === '/api/agent/heartbeat').pop()!
  expect(last.body.last_delivery_at).not.toBe('')
  expect(last.body.last_poll_at).not.toBe('')
  expect(last.body.events.some((e: any) => e.kind === 'delivered' && e.msg.includes('msg_r1'))).toBe(true)
  expect(JSON.stringify(last.body)).not.toContain('Answer: A')
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
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(2000)
  opts.down = true
  await clock.advance(40000)
  expect(toasts.filter((t) => t.includes('cannot reach')).length).toBe(1)
  opts.down = false
  await clock.advance(40000)
  expect(toasts.filter((t) => t.includes('connected to the server again')).length).toBe(1)
  const last = server.calls.filter((c) => c.path === '/api/agent/heartbeat').pop()!
  const kinds = last.body.events.map((e: any) => e.kind)
  expect(kinds).toContain('api-error')
  expect(kinds).toContain('offline')
  expect(kinds).toContain('online')
})

test('when the delivered call fails the message is acknowledged again, never submitted twice', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const opts: any = { failPaths: /\/delivered$/ }
  const server = fakeServer(on, [REPLY], opts)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
  expect(server.delivered.size).toBe(0)
  // The server lists the message again (its claim went stale); the mod only acknowledges.
  opts.failPaths = undefined
  server.releaseAll()
  await clock.advance(30000)
  expect(server.submitted.length).toBe(1)
  expect([...server.delivered]).toEqual(['msg_r1'])
})

for (const restart of [false, true]) {
  test(`/clear (session.end reason clear${restart ? ', then a session.start' : ', no start after'}): heartbeat and polling go on, hello is re-sent`, async ($, on) => {
    const clock = mock.clock(on)
    mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
    const id = { current: 'claude-1' }
    const pending: any[] = []
    const server = fakeServer(on, pending, { id })
    on('session.end', (_: any, e: any) => ({ sessionId: e.sessionId }))
    await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    await clock.advance(5000)
    const hellos = () => server.calls.filter((c) => c.path === '/api/agent/hello')
    const beats = () => server.calls.filter((c) => c.path === '/api/agent/heartbeat').length
    expect(hellos().length).toBe(1)

    id.current = 'claude-2'
    await $.session.end({ reason: 'clear', sessionId: 'claude-1', resume: {} } as any)
    if (restart) await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
    const before = beats()
    await clock.advance(40_000)
    expect(beats()).toBeGreaterThan(before + 1) // the 15 s heartbeat did not stop
    expect(hellos().at(-1)!.body).toEqual({ claude_session_id: 'claude-2' })
    // a reply sent after the clear is still picked up and delivered
    pending.push(REPLY)
    await clock.advance(5000)
    expect(server.submitted.length).toBe(1)
    expect([...server.delivered]).toEqual(['msg_r1'])
  })
}

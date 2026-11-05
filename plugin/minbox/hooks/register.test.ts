import { expect, mock, test } from 'claude-code/testing'
import { asksPerson, ATTACHMENTS_GUIDE, opensBrowser, SEND_DESCRIPTION, sentText, threadText } from './text'

const SERVER_FILE = '/data/server.json'

type Call = { method: string; path: string; body: any }

/** A minbox server in memory: answers the mod's HTTP calls. */
function fakeServer(on: any, pending: any[], opts: { extra?: string } = {}) {
  const calls: Call[] = []
  const submitted: string[] = []
  const delivered = new Set<string>()
  const claimed = new Set<string>()
  on('fs.read', (_: any, e: any) => ({ value: e.path === SERVER_FILE ? JSON.stringify({ url: 'http://127.0.0.1:4848' }) : null }))
  on('session.id', () => ({ value: 'claude-1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId ?? 't' }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer ?? '' }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__minbox__${e.name}` } }))
  on('http.fetch', (_: any, e: any) => {
    const url = new URL(e.url)
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    const method = e.init?.method ?? 'GET'
    calls.push({ method, path: url.pathname, body })
    const ok = (json: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(json) } })
    if (url.pathname === '/api/agent/pending') {
      return ok(pending.filter((p) => !claimed.has(p.id)))
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
    if (url.pathname === '/api/agent/hello') return ok({ session_id: 's', name: 'n', prompt_extra: opts.extra ?? '' })
    if (url.pathname === '/api/agent/cards' && method === 'POST') {
      return { value: { status: 201, ok: true, headers: {}, text: JSON.stringify({ id: 'card_1', title: body.title, column: body.column ?? 'backlog', note: '' }) } }
    }
    if (url.pathname === '/api/agent/messages') {
      return ok({ thread_id: 'thr_1', message_id: 'msg_1', new_thread: true, questions: [{ key: 'q-1', kind: 'single', prompt: 'A or B?' }] })
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
  return { calls, submitted, delivered }
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
  expect([...server.delivered]).toEqual(['msg_r1'])
  // The hello carried the conversation id.
  expect(server.calls.find((c) => c.path === '/api/agent/hello')?.body).toEqual({ claude_session_id: 'claude-1' })

  await clock.advance(5000)
  expect(server.submitted.length).toBe(1)
})

test('send_message posts the message and says the reply comes by itself', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const res: any = await $.tool.call({ tool: 'mcp__minbox__send_message', body: ':::question\nA or B?\n- [ ] A\n- [ ] B\n:::', thread_title: 'Plan' })
  expect(res.result).toContain('Started thread thr_1')
  expect(res.result).toContain('Do not wait or poll')
  const post = server.calls.find((c) => c.path === '/api/agent/messages')
  expect(post?.body.thread_title).toBe('Plan')
})

test('send_message still forwards the old subject parameter as thread_title', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'hi', subject: 'Old' } as any)
  expect(server.calls.find((c) => c.path === '/api/agent/messages')?.body.thread_title).toBe('Old')
})

test('the first prompt carries the inbox reminder', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.prompt.submit({ text: 'hello' })
  expect(res.context?.join('\n') ?? '').toContain('minbox inbox is on')
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

test('the reminder carries the extra instructions from settings', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [], { extra: 'Reply in Japanese.' })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const res: any = await $.prompt.submit({ text: 'hello' })
  expect(res.context?.join('\n') ?? '').toContain('The person adds: Reply in Japanese.')
})

test('send_message passes attachments and a review; card creates a card', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'see', attachments: ['plan.md'], review: { title: 'R', sections: [{ title: 'a', files: ['a.go'] }] }, name: 'tag' } as any)
  const post = server.calls.find((c) => c.path === '/api/agent/messages')
  expect(post?.body.attachments).toEqual(['plan.md'])
  expect(post?.body.review.title).toBe('R')
  expect(post?.body.name).toBe('tag')

  const res: any = await $.tool.call({ tool: 'mcp__minbox__card', action: 'create', title: 'Search UI', column: 'designing' } as any)
  expect(res.result).toContain('Created card card_1 [designing] Search UI')
  const bad: any = await $.tool.call({ tool: 'mcp__minbox__card', action: 'update' } as any)
  expect(bad.deny).toContain('card id')
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

test('set_session_title sets the title, and the system prompt asks for it', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  const section = composed.sections.find((s: any) => s.id === 'minbox:session-title')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('mcp__minbox__set_session_title')

  const res: any = await $.tool.call({ tool: 'mcp__minbox__set_session_title', title: '  Fix login redirect  ' } as any)
  const call = server.calls.find((c) => c.path === '/api/agent/title')
  expect(call?.body).toEqual({ title: 'Fix login redirect' })
  expect(JSON.stringify(res)).toContain('Session title set')
})

test('open_url opens the page in the browser; Bash opening it on the host is refused', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }))
  let ran = ''
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => {
    ran = e.command
    return { result: 'ok' }
  })
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(composed.sections.find((s: any) => s.id === 'minbox:open-url')?.text).toContain('mcp__minbox__open_url')

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

test('without prompt.compose the first prompt still carries the title and open_url guidance; compose does not repeat the command line', async ($, on) => {
  mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  fakeServer(on, [])
  // The system prompt already holds minbox's --append-system-prompt.
  on('prompt.compose', () => ({ sections: [{ id: 'append', text: '# minbox: inbox\n…\n\n# minbox: session title\n…\n\n# minbox: opening pages\n…', scope: 'session' }] }))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const first: any = await $.prompt.submit({ text: 'open the PR', origin: { kind: 'composer' } } as any)
  const extra = (first.context ?? []).join('\n')
  expect(extra).toContain('mcp__minbox__open_url')
  expect(extra).toContain('mcp__minbox__set_session_title')

  const composed: any = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as any)
  expect(composed.sections.map((s: any) => s.id)).toEqual(['append'])
})

test('a turn that asks the person in the chat only is followed by one reminder to use the inbox', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { MINBOX_TOKEN: 'tok', MINBOX_SERVER_FILE: SERVER_FILE })
  const server = fakeServer(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })

  const turn = async (answer: string, send = false) => {
    await $.turn.start({ turnId: 't', prompt: 'p' } as any)
    if (send) await $.tool.call({ tool: 'mcp__minbox__send_message', body: 'Which one?', subject: 'Pick' } as any)
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

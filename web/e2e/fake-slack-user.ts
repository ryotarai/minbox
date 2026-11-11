import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A fake Slack Web API for the PERSONAL (user token) integration, on 127.0.0.1: auth.test (with the
 * x-oauth-scopes header), the Real-time Search API and the legacy search, conversations.replies /
 * history / info and users.info, with a small scenario. Every Minbox gets one and is pointed at it
 * with MINBOX_SLACK_API_URL (honoured by the server only for http loopback URLs). No real Slack is
 * ever contacted. The token is built at run time (no token-shaped literal in the source).
 */
export const FAKE_USER_TOKEN = ['xoxp', '1111111111', '2222222222', 'e2eFAKEtoken0123456789'].join('-')

const nowS = Math.floor(Date.now() / 1000)
const ts = (agoMin: number, n: number) => `${nowS - agoMin * 60}.${String(n).padStart(6, '0')}`

export class FakeSlackUser {
  url = ''
  private srv: Server | null = null
  me = 'U_ME'
  scopes = 'search:read.public,search:read.private,search:read.im,channels:history,groups:history,im:history,users:read,im:read'
  /** An error code for assistant.search.context ('' = works), e.g. 'unknown_method' makes Auto fall back. */
  rtsError = ''
  /** Seconds for a 429 on conversations.replies (0 = none). */
  repliesLimit = 0
  calls: { method: string; args: any }[] = []
  users: Record<string, string> = { U_ME: 'Ryota', U_ALICE: 'Alice', U_BOB: 'Bob' }
  t1 = ts(120, 1)
  t2 = ts(300, 3)
  t3 = ts(360, 6)
  d1 = ts(30, 5)
  replies: Record<string, any[]> = {}
  history: Record<string, any[]> = {}

  constructor() {
    this.reset()
  }

  /** The scenario: a review request (needs me), a DM, a thread that only says thanks, a thread I answered last. */
  reset() {
    const t1b = ts(90, 2)
    this.replies = {
      [`C1:${this.t1}`]: [
        { ts: this.t1, user: 'U_ALICE', text: '<@U_ME> can you review *PR 12* before noon? It touches the `auth` flow.\n> small change, but risky\nsee <https://example.com/pr/12|the PR>', files: [{ name: 'diff.patch', permalink: 'https://acme.slack.test/files/diff.patch' }] },
        { ts: t1b, user: 'U_ALICE', text: 'ping <@U_ME>, any news?' },
      ],
      [`C2:${this.t2}`]: [
        { ts: this.t2, user: 'U_BOB', text: 'Shall we ship the new design?' },
        { ts: ts(280, 4), user: 'U_ME', text: 'I think so' },
        { ts: ts(260, 5), user: 'U_BOB', text: 'ok thanks' },
      ],
      [`C3:${this.t3}`]: [
        { ts: this.t3, user: 'U_BOB', text: '<@U_ME> ping' },
        { ts: ts(350, 7), user: 'U_ME', text: 'on it' },
      ],
    }
    this.history = { D1: [{ ts: this.d1, user: 'U_ALICE', text: 'are you free for a quick call?' }, { ts: ts(31, 4), user: 'U_ME', text: 'hi' }] }
  }

  count(method: string) {
    return this.calls.filter((c) => c.method === method).length
  }

  private hits(kind: string, rts: boolean): any[] {
    const link = (c: string, t: string, thread?: string) => `https://acme.slack.test/archives/${c}/p${t.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=${c}` : ''}`
    const h = (c: string, name: string, t: string, user: string, text: string, thread?: string) =>
      rts
        ? { channel_id: c, channel_name: name, message_ts: t, author_user_id: user, content: text, permalink: link(c, t, thread) }
        : { channel: { id: c, name, is_im: c.startsWith('D') }, ts: t, user, text, permalink: link(c, t, thread) }
    if (kind === 'mention') return [h('C1', 'eng', this.t1, 'U_ALICE', '<@U_ME> can you review PR 12'), h('C3', 'ops', this.t3, 'U_BOB', '<@U_ME> ping')]
    if (kind === 'dm') return [h('D1', 'U_ALICE', this.d1, 'U_ALICE', 'are you free for a quick call?')]
    return [h('C2', 'design', ts(280, 4), 'U_ME', 'I think so', this.t2)]
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const method = (req.url ?? '').replace(/^\//, '').split('?')[0]
    let raw = ''
    for await (const c of req) raw += c
    let args: any = {}
    if ((req.headers['content-type'] ?? '').startsWith('application/json')) args = raw ? JSON.parse(raw) : {}
    else for (const [k, v] of new URLSearchParams(raw)) args[k] = v
    this.calls.push({ method, args })
    const out = (v: any, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(v))
    }
    const fail = (error: string, extra: any = {}) => out({ ok: false, error, ...extra })
    if (req.headers.authorization !== `Bearer ${FAKE_USER_TOKEN}`) return fail('invalid_auth')
    const kindOf = (q: string) => (q.includes('to:') ? 'dm' : /from:|is:thread/.test(q) ? 'part' : 'mention')
    switch (method) {
      case 'auth.test':
        return out({ ok: true, user_id: this.me, user: 'ryota', team_id: 'T1', team: 'Acme', url: 'https://acme.slack.test/' }, 200, this.scopes ? { 'X-OAuth-Scopes': this.scopes } : {})
      case 'assistant.search.context':
        if (this.rtsError) return fail(this.rtsError)
        return out({ ok: true, results: { messages: this.hits(kindOf(args.query ?? ''), true) }, response_metadata: { next_cursor: '' } })
      case 'search.messages':
        return out({ ok: true, messages: { matches: this.hits(kindOf(args.query ?? ''), false), paging: { pages: 1, page: 1 } } })
      case 'conversations.replies': {
        if (this.repliesLimit) return out({}, 429, { 'Retry-After': String(this.repliesLimit) })
        const m = this.replies[`${args.channel}:${args.ts}`]
        return m ? out({ ok: true, messages: m, has_more: false }) : fail('thread_not_found')
      }
      case 'conversations.history':
        return out({ ok: true, messages: this.history[args.channel] ?? [] })
      case 'conversations.info':
        return out({ ok: true, channel: { id: args.channel, is_im: true, user: 'U_ALICE', last_read: '1', unread_count_display: 2 } })
      case 'users.info': {
        const n = this.users[args.user]
        return n ? out({ ok: true, user: { id: args.user, name: n.toLowerCase(), real_name: n, profile: { display_name: n } } }) : fail('user_not_found')
      }
    }
    return fail('unknown_method')
  }

  async start() {
    this.srv = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.srv!.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.srv.address() as AddressInfo).port}`
  }

  close() {
    return new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()))
  }
}

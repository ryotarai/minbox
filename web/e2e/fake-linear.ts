import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'

/**
 * A fake Linear on 127.0.0.1: the OAuth server (discovery, dynamic client registration, PKCE) and the
 * MCP endpoint (Streamable HTTP, answers as SSE) with a few issues, comments and workflow states.
 * Every Minbox gets one and is pointed at it with MINBOX_LINEAR_MCP_URL (the server honours that
 * only for http loopback URLs). No real Linear is ever contacted.
 */
export class FakeLinear {
  url = ''
  private srv: Server | null = null
  private clients = new Map<string, string>() // client_id -> redirect uri
  private codes = new Map<string, { challenge: string; redirect: string }>()
  private access = ''
  private refresh = ''
  issue: any = {
    id: 'iss-uuid-1',
    identifier: 'ENG-123',
    title: 'Fix the thing',
    state: { name: 'Todo', type: 'unstarted' },
    team: { id: 'team-1', name: 'Engineering' },
    assignee: 'Alice',
    url: 'https://linear.app/some-workspace/issue/ENG-123/fix-the-thing',
  }
  comments: any[] = []
  /** Issues made by save_issue without an id (the Create-issue dialog). */
  created: any[] = []
  calls: { tool: string; args: any }[] = []
  /** list_issue_labels answers a tool error (the Create dialog then warns). */
  failLabels = false
  /** Milliseconds list_issue_statuses waits before answering (to see the dialog's loading indicator). */
  statusesDelay = 0
  /** Team 2 (Design) has states and labels of its own. */
  designStatuses = [
    { id: 'st-d1', name: 'Backlog', type: 'backlog' },
    { id: 'st-d2', name: 'In Review', type: 'started' },
  ]
  private seq = 0
  statuses = [
    { id: 'st-2', name: 'Todo', type: 'unstarted' },
    { id: 'st-3', name: 'In Progress', type: 'started' },
    { id: 'st-4', name: 'Done', type: 'completed' },
  ]

  async start() {
    this.srv = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((r) => this.srv!.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.srv.address() as AddressInfo).port}`
  }

  close() {
    return new Promise<void>((r) => (this.srv ? this.srv.close(() => r()) : r()))
  }

  addComment(author: string, body: string) {
    this.comments.push({ id: `c-${++this.seq}`, body, createdAt: new Date().toISOString(), user: { name: author } })
  }

  private json(res: ServerResponse, code: number, v: unknown, headers: Record<string, string> = {}) {
    res.writeHead(code, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(v))
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', this.url)
    let raw = ''
    for await (const d of req) raw += d
    const path = u.pathname
    if (path.startsWith('/.well-known/oauth-protected-resource'))
      return this.json(res, 200, { resource: this.url, authorization_servers: [this.url], scopes_supported: ['read', 'write'] })
    if (path === '/.well-known/oauth-authorization-server')
      return this.json(res, 200, {
        issuer: this.url,
        authorization_endpoint: this.url + '/authorize',
        token_endpoint: this.url + '/token',
        registration_endpoint: this.url + '/register',
        scopes_supported: ['read', 'write'],
      })
    if (path === '/register') {
      const b = JSON.parse(raw || '{}')
      const id = 'client-' + randomBytes(4).toString('hex')
      this.clients.set(id, b.redirect_uris?.[0] ?? '')
      return this.json(res, 201, { client_id: id, token_endpoint_auth_method: 'none' })
    }
    if (path === '/authorize') {
      const q = u.searchParams
      const redirect = this.clients.get(q.get('client_id') ?? '')
      if (!redirect || redirect !== q.get('redirect_uri') || q.get('code_challenge_method') !== 'S256') {
        res.writeHead(400)
        return res.end('bad authorize request')
      }
      const code = 'code-' + randomBytes(6).toString('hex')
      this.codes.set(code, { challenge: q.get('code_challenge') ?? '', redirect })
      const back = new URL(redirect)
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.get('state') ?? '')
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }
    if (path === '/token') {
      const f = new URLSearchParams(raw)
      if (f.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(f.get('code') ?? '')
        this.codes.delete(f.get('code') ?? '')
        const challenge = createHash('sha256')
          .update(f.get('code_verifier') ?? '')
          .digest('base64url')
        if (!c || challenge !== c.challenge) return this.json(res, 400, { error: 'invalid_grant' })
      } else if (f.get('refresh_token') !== this.refresh) return this.json(res, 400, { error: 'invalid_grant' })
      this.access = 'at_' + randomBytes(10).toString('hex')
      this.refresh = 'rt_' + randomBytes(10).toString('hex')
      return this.json(res, 200, { access_token: this.access, refresh_token: this.refresh, token_type: 'Bearer', expires_in: 3600 })
    }
    if (path === '/mcp') return this.mcp(req, res, raw)
    res.writeHead(404)
    res.end()
  }

  private mcp(req: IncomingMessage, res: ServerResponse, raw: string) {
    if (!this.access || req.headers.authorization !== 'Bearer ' + this.access) {
      res.writeHead(401)
      return res.end()
    }
    const r = JSON.parse(raw || '{}')
    const sse = (result: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', ...headers })
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: r.id, result })}\n\n`)
    }
    const text = (v: unknown) => sse({ content: [{ type: 'text', text: JSON.stringify(v) }] })
    const schema = (...props: string[]) => ({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) })
    switch (r.method) {
      case 'notifications/initialized':
        res.writeHead(202)
        return res.end()
      case 'initialize':
        return sse({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-linear' } }, { 'mcp-session-id': 'sess-' + randomBytes(3).toString('hex') })
      case 'tools/list':
        return sse({
          tools: [
            { name: 'get_user', inputSchema: schema('query') },
            { name: 'get_issue', inputSchema: schema('id') },
            { name: 'list_comments', inputSchema: schema('issueId') },
            { name: 'list_issue_statuses', inputSchema: schema('team') },
            { name: 'save_comment', inputSchema: schema('issueId', 'body', 'id') },
            {
              name: 'save_issue',
              inputSchema: {
                type: 'object',
                properties: {
                  ...schema('id', 'state', 'title', 'description', 'team', 'assignee', 'project').properties,
                  priority: { type: 'number' },
                  labels: { type: 'array', items: { type: 'string' } },
                },
              },
            },
            { name: 'list_teams', inputSchema: schema('query') },
            { name: 'list_issue_labels', inputSchema: schema('team', 'limit') },
            { name: 'list_projects', inputSchema: schema('limit') },
          ],
        })
      case 'tools/call': {
        const { name, arguments: a = {} } = r.params
        this.calls.push({ tool: name, args: a })
        switch (name) {
          case 'get_user':
            return text({ id: 'u1', name: 'Ryota', email: 'ryota@example.com' })
          case 'list_teams':
            return text({ teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG' }, { id: 'team-2', name: 'Design', key: 'DES' }] })
          case 'list_issue_labels':
            if (this.failLabels) return sse({ isError: true, content: [{ type: 'text', text: 'labels are down' }] })
            if (a.team === 'team-2') return text({ labels: [{ id: 'lab-d1', name: 'Pixels' }] })
            return text({ labels: [{ id: 'lab-1', name: 'Bug' }, { id: 'lab-2', name: 'Feature' }] })
          case 'list_projects':
            return text({ projects: [{ id: 'proj-1', name: 'Website' }] })
          case 'get_issue': {
            const made = this.created.find((c) => c.identifier === a.id || c.id === a.id)
            if (made) return text(made)
            return a.id === 'ENG-123' || a.id === this.issue.id ? text(this.issue) : sse({ isError: true, content: [{ type: 'text', text: 'Entity not found' }] })
          }
          case 'list_comments':
            return text({ comments: this.comments })
          case 'list_issue_statuses': {
            const sts = a.team === 'team-2' ? this.designStatuses : this.statuses
            if (this.statusesDelay > 0) return void setTimeout(() => text({ statuses: sts }), this.statusesDelay)
            return text({ statuses: sts })
          }
          case 'save_issue': {
            if (!a.id) {
              const n = this.created.length + 1
              const state = this.statuses.find((x) => x.id === a.state || x.name === a.state) ?? this.statuses[0]
              const iss = {
                id: `iss-new-${n}`,
                identifier: `ENG-${100 + n}`,
                title: a.title,
                description: a.description,
                url: `https://linear.app/some-workspace/issue/ENG-${100 + n}/new`,
                state: { name: state.name, type: state.type },
                team: { id: a.team, name: 'Engineering' },
              }
              this.created.push({ ...iss, args: a })
              return text(iss)
            }
            const st = this.statuses.find((s) => s.name === a.state)
            if (st) this.issue.state = { name: st.name, type: st.type }
            return text(this.issue)
          }
          case 'save_comment': {
            if (a.id) {
              const c = this.comments.find((c) => c.id === a.id)
              if (!c) return sse({ isError: true, content: [{ type: 'text', text: 'Comment not found' }] })
              c.body = a.body
              return text(c)
            }
            const c = { id: `c-${++this.seq}`, body: a.body, createdAt: new Date().toISOString(), user: { name: 'Ryota' } }
            this.comments.push(c)
            return text(c)
          }
        }
      }
    }
    sse({})
  }
}

// Types and client for minbox's browser API (docs/api-contract.md).

export type SessionStatus = 'starting' | 'working' | 'idle' | 'ended'
export type Section = 'stopped' | 'holding' | 'waiting' | 'sent' | 'new' | 'quiet' | 'snoozed' | 'archived'
export type ThreadStatus = 'working' | 'need_action' | 'finished'
/** Display order and labels of thread statuses. */
export const THREAD_STATUS_ORDER: ThreadStatus[] = ['need_action', 'working', 'finished']
export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = { need_action: 'Needs action', working: 'Working', finished: 'Finished' }
export type Delivery = 'queued' | 'sending' | 'delivered' | 'undelivered'

export const SECTION_ORDER: Section[] = ['stopped', 'holding', 'waiting', 'sent', 'new', 'quiet', 'snoozed', 'archived']
export const SECTION_LABEL: Record<Section, string> = {
  stopped: 'Stopped on you',
  holding: 'Holding up work',
  waiting: 'Waiting on you',
  sent: 'Sent',
  new: 'New since you looked',
  quiet: 'Quiet',
  snoozed: 'Snoozed',
  archived: 'Archived',
}
/** Sections that wait on the person. */
export const ATTENTION: Section[] = ['stopped', 'holding', 'waiting']

export type TopThread = {
  id: string
  status?: ThreadStatus
  subject: string
  section: Section
  updated_at: string
  last_author: 'agent' | 'user' | ''
  last_delivery?: Delivery
  open_questions: number
  stopped: boolean
  holds_up: number
}

export type SessionKind = 'claude' | 'shell'

export type Session = {
  id: string
  /** claude: Claude Code with the inbox; shell: a plain login shell (terminal only). */
  kind?: SessionKind
  /** What Claude says it is working on (set_session_title); '' until set. */
  title?: string
  name: string
  cwd: string
  status: SessionStatus
  claude_session_id: string
  exit_code: number | null
  created_at: string
  updated_at: string
  unread: number
  open_questions: number
  waiting: number
  archived_at?: string | null
  section?: Section
  stopped?: number
  holding?: number
  undelivered?: number
  /** When the mod last called the server (null: not since the server started). */
  mod_seen_at?: string | null
  /** A Claude Code session whose mod has been silent for a while (45 s). */
  mod_silent?: boolean
  last_activity?: string
  top_thread?: TopThread | null
  host_id?: string
  host_name?: string
  /** The project (host + folder) the session belongs to. */
  project_id?: string
  /** The project's main session: new threads go to it by default. */
  is_main?: boolean
}

/** A folder on a host; sessions (and so threads) are resources under it. */
export type Project = {
  id: string
  name: string
  /** '' for the catch-all "No project". */
  dir: string
  host_id: string
  host_name?: string
  created_at: string
  archived_at: string | null
  pinned_at: string | null
  /** The Claude Code session a new thread goes to by default ('' until the project has one). */
  main_session_id: string
  session_count: number
  live_sessions: number
  last_activity: string
}

export type Device = { id: string; name: string; fingerprint: string; created_at: string; last_seen: string | null; current: boolean }
export type PairRequest = { id: string; code: string; name: string; fingerprint: string; created_at: string; ip?: string; tailscale_login?: string }
export type DeviceMe = { trusted: boolean; via: 'loopback' | 'device' | null; device?: Device }

export type Host = {
  id: string
  name: string
  url: string
  builtin: boolean
  method?: 'builtin' | 'tailscale' | 'direct'
  tailscale_login?: string
  paired?: boolean
  pairing_code?: string
  fingerprint?: string
  status: 'online' | 'offline' | 'connecting' | 'pairing'
  version?: string
  os?: string
  arch?: string
  latency_ms?: number
  last_seen?: string | null
  error?: string
  sessions: number
}

export type HostProbe = { ok: boolean; version?: string; os?: string; arch?: string; hostname?: string; tailscale?: boolean; error?: string }
export type TailnetPeer = { name: string; dns_name: string; os: string; online: boolean; has_host: boolean; added: boolean }
export type TailscaleInfo = { available: boolean; login?: string; suffix?: string; peers?: TailnetPeer[] }

export type Choice = { label: string; description?: string; settled?: boolean; recommended?: boolean }

export type Question = {
  key: string
  kind: 'single' | 'multi' | 'text' | 'action'
  prompt: string
  context?: string
  choices?: Choice[]
  recommended_text?: string
  stopped?: string
  holds_up?: string[]
  replaces?: string
  group?: string
}

export type Answer = {
  key: string
  selected?: string[]
  other?: string
  text?: string
  note?: string
  skipped?: boolean
}

export type AttachmentType = 'markdown' | 'text' | 'html' | 'mermaid' | 'graphviz' | 'code' | 'image' | 'video' | 'pdf' | 'file'

export type Attachment = {
  id: string
  thread_id: string
  message_id: string
  author?: 'agent' | 'user'
  kind: 'file' | 'review'
  /** What the file is (Plannotator's attachment kinds). */
  type?: AttachmentType
  name: string
  path: string
  named_path?: string | null
  mime: string
  size: number
  width?: number
  height?: number
  duration_ms?: number
  sent_mtime?: string
  created_at: string
  inline?: boolean
  /** An inline image: the src as written in the message. */
  ref?: string
}

export type ReviewFile = { path: string; additions: number; deletions: number; diff: string }
export type Review = {
  title: string
  summary: string
  additions: number
  deletions: number
  sections: { title: string; summary: string; files: ReviewFile[] }[]
}

export type AttachmentDetail = Attachment & {
  exists: boolean
  changed: boolean
  modified_at?: string | null
  current_size?: number
  unavailable?: { code: 'attachment_missing' | 'attachment_changed_type'; message: string } | null
  text_sent?: string
  text_current?: string
  review?: Review
}

export type Annotation = {
  kind: 'comment' | 'region' | 'pen' | 'video' | 'element' | 'diagram'
  attachment_id?: string
  version?: 'current' | 'sent'
  name?: string
  /** The words or element the comment is on (Plannotator's originalText). */
  quote?: string
  line_start?: number
  line_end?: number
  /** Video: seconds into it. */
  time?: number
  comment: string
  images?: { path: string; name: string }[]
  region?: { x: number; y: number; w: number; h: number; natural_w: number; natural_h: number }
  /** Kept by this browser: when it was written. */
  at?: number
  /** Guided review diff comments still use line + image_path. */
  line?: number
  image_path?: string
}

export type ClosedReason = 'moved_on' | 'replaced' | 'marked_read' | 'archived'

export type Message = {
  id: string
  thread_id: string
  author: 'agent' | 'user'
  body: string
  words?: string
  questions?: Question[] | null
  answers?: Answer[] | null
  answers_for?: string
  created_at: string
  read_at: string | null
  claimed_at: string | null
  delivered_at: string | null
  answer_state?: Record<string, Answer> | null
  delivery?: Delivery
  kind?: 'message' | 'note'
  attachments?: Attachment[] | null
  inline_images?: Attachment[] | null
  annotations?: Annotation[] | null
  urgent?: boolean
  closed?: Record<string, ClosedReason> | null
}

export type Thread = {
  id: string
  session_id: string
  project_id?: string
  project_name?: string
  subject: string
  created_at: string
  updated_at: string
  messages?: Message[]
  /** What the thread is doing; set by messages and by hand. */
  status: ThreadStatus
  unread: number
  open_questions: number
  section: Section
  last_body: string
  last_author: 'agent' | 'user' | ''
  last_delivery?: Delivery
  name?: string
  archived_at?: string | null
  pinned_at?: string | null
  snoozed_until?: string | null
  marked_read_at?: string | null
  came_back?: boolean
  stopped?: boolean
  holds_up?: number
  open_actions?: number
  message_count?: number
  attachment_count?: number
  last_agent_at?: string | null
}

export type Card = {
  id: string
  title: string
  column: CardColumn
  note: string
  session_id: string | null
  thread_id: string | null
  pr_url: string
  pr_state: '' | 'draft' | 'open' | 'merged' | 'closed'
  pr_number: number
  created_by: 'agent' | 'user'
  dropped_by: '' | 'agent' | 'user'
  position: number
  created_at: string
  updated_at: string
}
export type CardColumn = 'backlog' | 'designing' | 'look' | 'building' | 'review' | 'shipped' | 'icebox' | 'dropped'

export type ListOptions = {
  highlight_subject: boolean
  compact: boolean
  hide_icons: boolean
  small_names: boolean
  keep_panel: boolean
}

export type Settings = {
  theme: 'system' | 'light' | 'dark'
  text_size: number
  notifications: boolean
  sound: boolean
  tab_count: boolean
  single_key: boolean
  board: boolean
  decision_mode: boolean
  /** The inbox pane left of the terminal (the default) instead of right of it. */
  swap_panes: boolean
  prompt_extra: string
  /** Append the orchestration block to the system prompt of sessions started or resumed from now on. */
  orchestrator_prompt: boolean
  /** The address this minbox is reached at from outside (Tailscale URL): notifications link to it. */
  public_url: string
  list: ListOptions
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  text_size: 13,
  notifications: true,
  sound: true,
  tab_count: true,
  single_key: true,
  board: false,
  decision_mode: false,
  swap_panes: true,
  prompt_extra: '',
  orchestrator_prompt: true,
  public_url: '',
  list: { highlight_subject: true, compact: false, hide_icons: false, small_names: false, keep_panel: false },
}

/** One config field of a notification destination type: the form is built from these. */
export type NotifyField = {
  key: string
  label: string
  kind: 'text' | 'secret' | 'bool' | 'select'
  required?: boolean
  default?: unknown
  placeholder?: string
  hint?: string
  options?: { value: string; label: string }[]
}
export type NotifyType = { id: string; label: string; fields: NotifyField[] }
export type NotifyDestination = {
  id: string
  type: string
  name: string
  enabled: boolean
  /** Secrets come masked ("https://hooks.slack.com/…ab12"). */
  config: Record<string, unknown>
  created_at: string
  last_ok_at: string | null
  last_error: string
  last_error_at: string | null
}

export type SearchHit = {
  thread_id: string
  session_id: string
  session_name: string
  subject: string
  message_id?: string
  attachment_id?: string
  name?: string
  author?: 'agent' | 'user'
  snippet: string
  archived: boolean
  section: Section
  created_at: string
}
export type SearchResult = { threads: SearchHit[]; messages: SearchHit[]; files: SearchHit[] }

export type Completion = { name: string; description: string }
export type Completions = { agents: Completion[]; skills: Completion[]; commands: Completion[] }

export type Storage = {
  data_dir: string
  db_path: string
  db_bytes: number
  scratch_dir: string
  scratch_bytes: number
  scratch_files: number
}
export type About = {
  version: string
  server_protocol: number
  required_host: number
  host: { protocol: number; required_server: number; pid: number } | null
  data_dir: string
}

export type ServerEvent = { type: 'sessions' | 'threads' | 'thread' | 'cards' | 'settings' | 'hosts' | 'devices' | 'projects' | 'notifications' | 'open'; session_id?: string; thread_id?: string; url?: string }

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// A browser reached over the network signs in with its paired key; when its
// cookie runs out, sign in again once and retry.
let reauth: Promise<boolean> | null = null
async function signInAgain(): Promise<boolean> {
  reauth ??= import('./lib/device').then((d) => d.authenticate()).catch(() => false).finally(() => setTimeout(() => (reauth = null), 1000))
  return reauth
}

/**
 * Before a stream (SSE, terminal socket) reconnects: a cheap guarded request, so a cookie the server
 * forgot (it restarted) goes through the 401 -> sign in again path. A failed EventSource or WebSocket
 * handshake does not expose its status, so the stream alone would retry unauthenticated forever.
 * Never rejects and never waits longer than a few seconds.
 */
export async function ensureSession(): Promise<void> {
  const probe = call('GET', '/api/settings').catch(() => undefined)
  await Promise.race([probe, new Promise((r) => setTimeout(r, 6000))])
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const send = () =>
    fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  let res = await send()
  if (res.status === 401 && !path.startsWith('/api/devices/')) {
    if (await signInAgain()) res = await send()
    else window.dispatchEvent(new Event('minbox:unpaired'))
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
    throw new ApiError(msg, res.status)
  }
  return json as T
}

const ok = { ok: true }
type Ok = typeof ok

export type ReplyRequest = {
  uploads?: string[]
  words: string
  answers_for?: string
  answers?: Answer[]
  annotations?: Annotation[]
  urgent?: boolean
  forward_to?: string
  resume?: boolean
}

export const api = {
  sessions: () => call<Session[]>('GET', '/api/sessions'),
  createSession: (cwd: string, name: string, host_id?: string, kind?: SessionKind) => call<Session>('POST', '/api/sessions', { cwd, name, host_id, kind }),
  /** A session inside a project: its host and folder. */
  createSessionIn: (project_id: string, name: string, kind?: SessionKind, main?: boolean) => call<Session>('POST', '/api/sessions', { project_id, name, kind, main: main || undefined }),
  setMainSession: (project_id: string, session_id: string) => call<Project>('PATCH', `/api/projects/${project_id}`, { main_session_id: session_id }),
  projects: (archived = false) => call<Project[]>('GET', `/api/projects${archived ? '?archived=1' : ''}`),
  createProject: (p: { dir: string; host_id?: string; name?: string }) => call<Project>('POST', '/api/projects', p),
  patchProject: (id: string, p: { name?: string; pinned?: boolean; dir?: string; host_id?: string }) => call<Project>('PATCH', `/api/projects/${id}`, p),
  deleteProject: (id: string) => call<Ok>('DELETE', `/api/projects/${id}`),
  archiveProject: (id: string, archive = true) => call<Ok>('POST', `/api/projects/${id}/${archive ? 'archive' : 'unarchive'}`),
  hosts: () => call<Host[]>('GET', '/api/hosts'),
  deviceMe: () => call<DeviceMe>('GET', '/api/devices/me'),
  devices: () => call<{ devices: Device[]; requests: PairRequest[] }>('GET', '/api/devices'),
  pairDevice: (public_key: string, name: string) => call<{ request_id: string; code: string; fingerprint: string }>('POST', '/api/devices/pair', { public_key, name }),
  pairStatus: (id: string) => call<{ status: 'pending' | 'accepted' | 'rejected' | 'expired' }>('GET', `/api/devices/pair/${id}`),
  acceptDevice: (id: string) => call<Ok>('POST', `/api/devices/requests/${id}/accept`),
  rejectDevice: (id: string) => call<Ok>('POST', `/api/devices/requests/${id}/reject`),
  revokeDevice: (id: string) => call<Ok>('DELETE', `/api/devices/${id}`),
  addHost: (h: { name: string; url: string; method: 'tailscale' | 'direct'; tailscale_login?: string }) => call<{ host: Host; code: string }>('POST', '/api/hosts', h),
  updateHost: (id: string, h: { name?: string; url?: string }) => call<Host>('PATCH', `/api/hosts/${id}`, h),
  removeHost: (id: string) => call<Ok>('DELETE', `/api/hosts/${id}`),
  probeHost: (url: string) => call<HostProbe>('POST', '/api/hosts/probe', { url }),
  tailscaleInfo: () => call<TailscaleInfo>('GET', '/api/hosts/tailscale'),
  repairHost: (id: string) => call<{ code: string }>('POST', `/api/hosts/${id}/repair`),
  retryHost: (id: string) => call<Ok>('POST', `/api/hosts/${id}/retry`),
  renameSession: (id: string, name: string) => call<Ok>('PATCH', `/api/sessions/${id}`, { name }),
  stopSession: (id: string) => call<Ok>('POST', `/api/sessions/${id}/stop`),
  restartSession: (id: string) => call<Ok>('POST', `/api/sessions/${id}/restart`),
  deleteSession: (id: string) => call<Ok>('DELETE', `/api/sessions/${id}`),
  archiveSession: (id: string) => call<Ok>('POST', `/api/sessions/${id}/archive`),
  unarchiveSession: (id: string) => call<Ok>('POST', `/api/sessions/${id}/unarchive`),
  completions: (id: string) => call<Completions>('GET', `/api/sessions/${id}/completions`),

  allThreads: () => call<Thread[]>('GET', '/api/threads'),
  threads: (sessionId: string) => call<Thread[]>('GET', `/api/sessions/${sessionId}/threads`),
  thread: (id: string) => call<Thread>('GET', `/api/threads/${id}`),
  createThread: (sessionId: string, subject: string, body: string, name?: string, uploads?: string[]) =>
    call<Thread>('POST', `/api/sessions/${sessionId}/threads`, { subject, body, name, uploads }),
  updateThread: (id: string, patch: { name?: string; subject?: string }) => call<Ok>('PATCH', `/api/threads/${id}`, patch),
  markSeen: (id: string) => call<{ marked: number }>('POST', `/api/threads/${id}/read`),
  markUnread: (id: string) => call<Ok>('POST', `/api/threads/${id}/unread`),
  markRead: (id: string) => call<Ok>('POST', `/api/threads/${id}/mark-read`),
  unmarkRead: (id: string) => call<Ok>('POST', `/api/threads/${id}/unmark-read`),
  archiveThread: (id: string) => call<Ok>('POST', `/api/threads/${id}/archive`),
  setThreadStatus: (id: string, status: ThreadStatus) => call<Ok>('POST', `/api/threads/${id}/status`, { status }),
  unarchiveThread: (id: string) => call<Ok>('POST', `/api/threads/${id}/unarchive`),
  pinThread: (id: string) => call<Ok>('POST', `/api/threads/${id}/pin`),
  unpinThread: (id: string) => call<Ok>('POST', `/api/threads/${id}/unpin`),
  snoozeThread: (id: string, until: Date) => call<Ok>('POST', `/api/threads/${id}/snooze`, { until: until.toISOString() }),
  unsnoozeThread: (id: string) => call<Ok>('POST', `/api/threads/${id}/unsnooze`),
  reask: (id: string) => call<Message>('POST', `/api/threads/${id}/reask`),
  reply: (threadId: string, req: ReplyRequest) =>
    call<Message & { forwarded_thread_id?: string; thread_id: string }>('POST', `/api/threads/${threadId}/reply`, req),
  sendNow: (messageId: string) => call<Ok>('POST', `/api/messages/${messageId}/send-now`),
  cancelMessage: (messageId: string) => call<{ ok: boolean; thread_id: string; thread_deleted: boolean }>('POST', `/api/messages/${messageId}/cancel`),

  attachment: (id: string) => call<AttachmentDetail>('GET', `/api/attachments/${id}`),
  attachmentRawUrl: (id: string, v: 'sent' | 'current' = 'sent') => `/api/attachments/${id}/raw?v=${v}`,
  attachmentDownloadUrl: (id: string, v: 'sent' | 'current' = 'current') => `/api/attachments/${id}/download?v=${v}`,
  attachmentView: (id: string, v: 'sent' | 'current') => call<{ text: string; html: string | null }>('GET', `/api/attachments/${id}/view?v=${v}`),
  linkedPage: (id: string, path: string) => call<{ name: string; path: string; text: string; html: string | null }>('GET', `/api/attachments/${id}/linked?path=${encodeURIComponent(path)}`),
  markdownImageUrl: (id: string, path: string, v: 'sent' | 'current') => `/api/attachments/${id}/markdown-image?path=${encodeURIComponent(path)}&v=${v}`,
  messageImageUrl: (messageId: string, ref: string) => `/api/messages/${messageId}/image?path=${encodeURIComponent(ref)}`,
  embed: (html: string) => call<{ id: string; url: string }>('POST', '/api/embeds', { html }),
  uploadText: (id: string) => call<{ text: string }>('GET', `/api/uploads/${id}/text`),
  deleteUpload: (id: string) => call<Ok>('DELETE', `/api/uploads/${id}`),

  search: (q: string, opts: { session_id?: string; status?: string; from?: string; limit?: number } = {}) => {
    const p = new URLSearchParams({ q })
    for (const [k, v] of Object.entries(opts)) if (v !== undefined && v !== '') p.set(k, String(v))
    return call<SearchResult>('GET', `/api/search?${p}`)
  },

  cards: () => call<Card[]>('GET', '/api/cards'),
  createCard: (c: Partial<Card>) => call<Card>('POST', '/api/cards', c),
  updateCard: (id: string, c: Partial<Card>) => call<Card>('PATCH', `/api/cards/${id}`, c),
  deleteCard: (id: string) => call<Ok>('DELETE', `/api/cards/${id}`),

  settings: () => call<Settings>('GET', '/api/settings'),
  saveSettings: (patch: Partial<Settings>) => call<Settings>('PUT', '/api/settings', patch),
  notifications: () => call<{ types: NotifyType[]; destinations: NotifyDestination[] }>('GET', '/api/notifications'),
  createNotification: (b: { type: string; name: string; enabled?: boolean; config: Record<string, unknown> }) => call<NotifyDestination>('POST', '/api/notifications', b),
  updateNotification: (id: string, b: { name?: string; enabled?: boolean; config?: Record<string, unknown> }) => call<NotifyDestination>('PATCH', `/api/notifications/${id}`, b),
  deleteNotification: (id: string) => call<Ok>('DELETE', `/api/notifications/${id}`),
  testNotification: (id: string) => call<{ ok: boolean; error?: string }>('POST', `/api/notifications/${id}/test`),
  storage: () => call<Storage>('GET', '/api/storage'),
  clearScratch: () => call<{ removed: number }>('POST', '/api/storage/clear-scratch'),
  about: () => call<About>('GET', '/api/about'),
}

/** Uploads a pasted image to the session's scratch area; answers its path. */
export async function uploadImage(sessionId: string, file: Blob): Promise<string> {
  const res = await fetch(`/api/sessions/${sessionId}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error ?? `upload failed (${res.status})`)
  return json.path as string
}

/** Uploads any file (compose attachments, annotated images); answers its path. */
export async function uploadFile(sessionId: string, file: File | Blob, name?: string): Promise<string> {
  const filename = name ?? (file instanceof File ? file.name : 'file')
  const res = await fetch(`/api/sessions/${sessionId}/files`, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(filename) },
    body: file,
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error ?? `upload failed (${res.status})`)
  return json.path as string
}

export type ConnectionState = { connected: boolean; attempts: number; since: Date | null }

/** Subscribes to the server's events; onOpen runs on every (re)connect. */
export function subscribe(
  onEvent: (e: ServerEvent) => void,
  onOpen: () => void,
  onState: (s: ConnectionState) => void,
): () => void {
  let es: EventSource | null = null
  let closed = false
  let attempts = 0
  let lostAt: Date | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let lastSeen = Date.now()
  let gen = 0
  let probing = false
  const connect = (probe = false) => {
    retry = null
    const g = ++gen
    if (!probe) {
      probing = false
      open()
      return
    }
    probing = true
    void ensureSession().then(() => {
      if (closed || g !== gen) return
      probing = false
      open()
    })
  }
  const open = () => {
    es = new EventSource('/api/events')
    lastSeen = Date.now()
    es.onopen = () => {
      lastSeen = Date.now()
      attempts = 0
      lostAt = null
      onState({ connected: true, attempts: 0, since: null })
      onOpen()
    }
    es.onmessage = (m) => {
      lastSeen = Date.now()
      try {
        onEvent(JSON.parse(m.data))
      } catch {
        /* ignore */
      }
    }
    es.onerror = () => {
      es?.close()
      if (closed) return
      attempts++
      lostAt ??= new Date()
      onState({ connected: false, attempts, since: lostAt })
      retry = setTimeout(() => connect(true), Math.min(1000 * attempts, 5000))
    }
  }
  connect()
  const reconnectNow = () => {
    if (retry) clearTimeout(retry)
    es?.close()
    connect(true)
  }
  ;(window as unknown as { __minboxReconnect?: () => void }).__minboxReconnect = reconnectNow
  // A connection can die without an error (a sleeping tablet, a dropped Wi-Fi): the server sends a
  // ping every 20 s, so silence means it is gone. Check on a timer and when the page comes back.
  const STALE_MS = 50_000
  const CONNECT_MS = 10_000
  const check = () => {
    if (closed || retry || probing) return // already waiting to retry
    // One that never opened (CONNECTING, no error) is replaced after CONNECT_MS, not STALE_MS.
    const hung = es?.readyState === EventSource.CONNECTING && Date.now() - lastSeen > CONNECT_MS
    if (!es || es.readyState === EventSource.CLOSED || hung || Date.now() - lastSeen > STALE_MS) reconnectNow()
  }
  const watch = setInterval(check, 10_000)
  const onWake = () => {
    if (closed || probing) return
    if (retry) reconnectNow()
    else if (document.visibilityState !== 'hidden' && (es?.readyState !== EventSource.OPEN || Date.now() - lastSeen > 25_000)) reconnectNow()
  }
  window.addEventListener('online', onWake)
  document.addEventListener('visibilitychange', onWake)
  return () => {
    closed = true
    clearInterval(watch)
    window.removeEventListener('online', onWake)
    document.removeEventListener('visibilitychange', onWake)
    if (retry) clearTimeout(retry)
    es?.close()
  }
}

export function reconnectEvents() {
  ;(window as unknown as { __minboxReconnect?: () => void }).__minboxReconnect?.()
}

export type Upload = {
  upload_id: string
  name: string
  size: number
  type: AttachmentType
  sha256: string
  created_at: string
  mime?: string
  width?: number
  height?: number
}

/** Uploads a file as the raw body, reporting progress; abortable. */
export function uploadToInbox(file: Blob, name: string, onProgress: (sent: number, total: number) => void): { promise: Promise<Upload>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<Upload>((resolve, reject) => {
    xhr.open('POST', `/api/uploads?name=${encodeURIComponent(name)}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.total || file.size)
    xhr.onload = () => {
      let json: { upload?: Upload; error?: string } | null = null
      try {
        json = JSON.parse(xhr.responseText)
      } catch {
        json = null
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.upload) resolve(json.upload)
      else reject(new Error(json?.error ?? `upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('upload failed (network)'))
    xhr.onabort = () => reject(new Error('aborted'))
    xhr.send(file)
  })
  return { promise, abort: () => xhr.abort() }
}

/** Saves a drawn-on image (a markup); answers its absolute path and name. */
export async function uploadMarkup(blob: Blob): Promise<{ path: string; name: string; url: string }> {
  const res = await fetch('/api/markups', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/png' }, body: blob })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.error ?? `upload failed (${res.status})`)
  return json
}

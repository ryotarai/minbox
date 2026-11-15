// Types and client for minbox's browser API (docs/api-contract.md).

export type SessionStatus = 'starting' | 'working' | 'idle' | 'ended'
export type Section = 'stopped' | 'holding' | 'waiting' | 'sent' | 'new' | 'quiet' | 'snoozed' | 'archived'
export type ThreadStatus = 'working' | 'need_action' | 'blocked' | 'finished'
/** Display order and labels of thread statuses. */
export const THREAD_STATUS_ORDER: ThreadStatus[] = ['need_action', 'working', 'blocked', 'finished']
export const THREAD_STATUS_LABEL: Record<ThreadStatus, string> = { need_action: 'Needs action', working: 'Working', blocked: 'Blocked', finished: 'Finished' }
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

/** The coding agent a session runs (sessions.agent); a missing value means Claude Code. */
export type AgentKind = 'claude' | 'pi' | 'opencode'

/** A coding agent minbox can run, and whether it is installed on the server's machine, or on a host's (GET /api/agents?host_id=). */
export type AgentInfo = {
  kind: AgentKind
  label: string
  installed: boolean
  command: string
  path: string
  caps: { subagents: boolean; preassigned_id: boolean; remote_hosts: boolean; completions: boolean; movable_conversation?: boolean }
  /** The version minbox read (OpenCode; on a remote host Pi's is the host's Node, "node 22.19.0"). */
  version?: string
  /** False for an installed agent minbox cannot run (OpenCode 1.x); reason says why. */
  supported?: boolean
  reason?: string
}
export type AgentsInfo = { agents: AgentInfo[]; default: AgentKind; host_id?: string; error?: string }

export type Session = {
  id: string
  /** claude: Claude Code with the inbox; shell: a plain login shell (terminal only). */
  kind?: SessionKind
  /** Which coding agent runs the session (kind claude means "has the inbox"; this says which one). */
  agent?: AgentKind
  /** What Claude says it is working on (set_session_title); '' until set. */
  title?: string
  name: string
  cwd: string
  status: SessionStatus
  claude_session_id: string
  relocate_to?: string // the project folder changed: starts there next time
  prev_dir?: string
  prev_claude_session_id?: string
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
  /** The mod's connection, judged by its heartbeats: connected | stale | connecting | none. */
  mod_conn?: 'connected' | 'stale' | 'connecting' | 'none'
  /** The last heartbeat (null: none since the server started). */
  mod_beat_at?: string | null
  last_activity?: string
  top_thread?: TopThread | null
  host_id?: string
  host_name?: string
  /** The project (host + folder) the session belongs to. */
  project_id?: string
  /** The project's main session: new threads go to it by default. */
  is_main?: boolean
}

/** GET /api/sessions/{id}/connection: the diagnostics of a session's mod connection. */
export type ModConnectionInfo = {
  session_id: string
  state: 'connected' | 'stale' | 'connecting' | 'none'
  stale_after_s: number
  server_time: string
  server_started_at: string
  session_status: string
  heartbeat: boolean
  last_contact_at: string | null
  last_beat_at: string | null
  age_s: number | null
  beats?: number
  seq?: number
  agent?: string
  mod_version?: string
  mod_state?: string
  last_poll_at?: string
  last_delivery_at?: string
  mod_info?: Record<string, string | number | boolean> | null
  reconnects?: number
  stale_since?: string
  queue: { count: number; oldest_wait_s: number | null }
  mod_events: { at: string; kind: string; msg: string }[]
  events: { at: string; kind: string; msg: string }[]
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
  /** The agent new sessions of the project start with; '' follows the default_agent setting. */
  default_agent?: AgentKind | ''
  session_count: number
  live_sessions: number
  last_activity: string
  /** An emoji, or an uploaded image served at url; null when none. */
  icon?: { kind: 'emoji'; emoji: string } | { kind: 'image'; url: string } | null
}

export type Device= { id: string; name: string; fingerprint: string; created_at: string; last_seen: string | null; current: boolean }
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
  /** The coding agents found on that machine (null before the first look). */
  agents?: AgentInfo[] | null
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

export type MessageCommand = {
  message_id: string
  command: string
  cwd: string
  state: 'running' | 'done'
  exit_code: number
  timed_out: boolean
  truncated: boolean
  error?: string
  output: string
  duration_ms: number
  told: boolean
}

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
  kind?: 'message' | 'note' | 'command'
  command?: MessageCommand | null
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
  /** The linked Linear issue (GET /api/threads/{id} only). */
  linear?: ThreadLink
  linear_events?: LinearEvent[]
  /** A thread started from a message of another thread (see docs/thread-fork.md). */
  is_fork?: boolean
  fork_count?: number
  forked_from?: ForkedFrom
  forks?: ForkChild[]
}

export type ForkedFrom = {
  /** '' when the source thread is gone. */
  thread_id: string
  subject: string
  project_name: string
  session_name: string
  session_id: string
  message_id: string
  seq: number
  gone: boolean
  message_gone: boolean
  same_session: boolean
  carry_before: number
  /** What the agent got in front of the first message. */
  handoff: string
  created_at: string
}

export type ForkChild = {
  thread_id: string
  subject: string
  project_id: string
  project_name: string
  session_id: string
  session_name: string
  agent: string
  status: ThreadStatus
  from_message_id: string
  seq: number
  same_session: boolean
  archived_at: string | null
  created_at: string
}

export type ForkRequest = {
  message_id: string
  target: { kind: 'session' | 'new_session'; session_id?: string; project_id?: string; agent?: string; name?: string }
  before_n?: number
  subject?: string
  instruction?: string
}

export type ForkPreview = { handoff: string; message: string; text: string; bytes: number; subject: string; seq: number; agent: string; same_session: boolean; warnings: string[] }

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
  /** Draft up to three replies with Haiku when a thread opens (sends its recent messages to claude). */
  reply_suggestions: boolean
  /** The address this minbox is reached at from outside (Tailscale URL): notifications link to it. */
  public_url: string
  /** The agent a new session gets when nothing else says ('' : the installed one, Claude Code if both). */
  default_agent: AgentKind | ''
  linear: LinearSettings
  list: ListOptions
}

/** Settings › Integrations › Linear. Comments of everybody reach the agent unless an allow-list is set. */
export type LinearSettings = {
  author_filter: 'everyone' | 'allow_list'
  /** Linear names, emails or ids; comma or line separated. Only used with 'allow_list'. */
  allowed_authors: string
  /** Put the latest agent message in the progress comment (off: only subject and status). */
  include_body: boolean
  /** End a drafted issue's description with a link to the minbox thread (needs the public URL). */
  thread_link: boolean
  /** The person's extra instructions for the Create-issue auto-fill helper (at most 4000 characters). */
  draft_extra_prompt: string
}

/** Linear's own lists, for the Create-issue dialog. */
export type LinearListInfo = { list: string; tool?: string; pages: number; items: number; parsed: number; skipped: number; error?: string }

/** A team. Its states and labels are not part of the meta stage: they come with the team's lists once it is selected. */
export type LinearTeam = {
  id: string
  name: string
  key: string
  states?: { id: string; name: string; type: string }[]
  labels?: { id: string; name: string; color?: string }[]
  default_state_id?: string
  started_state_id?: string
}

export type LinearMeta = {
  user?: { id: string; name: string; email: string }
  teams: LinearTeam[]
  projects: { id: string; name: string; team_ids?: string[] }[]
  warnings?: string[]
  /** One entry per global list fetched: the tool used, pages, items read/parsed/skipped, the error. */
  lists?: LinearListInfo[]
}

/** The lists that hang on one team (fetched when the team is selected), with this fetch's warnings and summaries. */
export type LinearTeamLists = { team: LinearTeam; warnings?: string[]; lists?: LinearListInfo[] }

/** The fields of the Create-issue dialog (priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low). */
export type LinearDraft = {
  team_id: string
  title: string
  description: string
  priority: number
  label_ids: string[]
  project_id: string
  assignee_id: string
  state_id: string
}

export type LinearDraftResult = {
  meta?: LinearMeta
  /** Basic prefill without the helper agent. */
  fallback?: LinearDraft
  link_in_description?: boolean
  /** Meta stage: a helper agent is installed, so the dialog waits for its draft instead of prefilling. */
  llm_available?: boolean
  llm_reason?: 'no_agent'
  /** The helper agent's guess (ids already checked against the lists). */
  draft?: LinearDraft
  /** The drafted team's lists (the draft fetched them): the dialog need not ask again. */
  team_lists?: LinearTeamLists
  source?: 'llm'
  reason?: 'no_agent' | 'error'
  note?: string
}

export type LinearStatus = {
  mcp_url: string
  connected: boolean
  needs_login: boolean
  last_login_error?: string
  user?: { id: string; name: string; email: string }
  connected_at?: string
  last_error?: string
  /** What Connect registers with Linear from the address this browser uses. */
  redirect_uri: string
  rate_limited_for?: number
}

/** A thread's link to one Linear issue. */
export type ThreadLink = {
  thread_id: string
  issue_id: string
  identifier: string
  url: string
  title: string
  state: string
  state_type: string
  assignee: string
  last_synced_at: string | null
  last_error: string
  last_error_at: string | null
  include_body: boolean | null
  has_progress_comment: boolean
  syncing: boolean
}

/** A thread linked to a Linear issue (the My issues screen shows them on the issue). */
export type IssueThreadRef = { thread_id: string; session_id: string; subject: string; status: string; project_id: string; updated_at: string }

/** A Linear issue as the My issues screen shows it (the detail adds the description). */
export type IssueSummary = {
  id: string
  identifier: string
  title: string
  url: string
  state: string
  /** backlog | unstarted | started | completed | canceled | triage */
  state_type: string
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low */
  priority: number
  priority_name: string
  team_id: string
  team_key: string
  team_name: string
  project: string
  labels: string[]
  assignee: string
  estimate?: string
  due_date?: string
  created_at: string | null
  updated_at: string | null
  description?: string
  threads: IssueThreadRef[]
}

export type IssueListResult = {
  /** null: nothing cached (cached=1 only). */
  issues: IssueSummary[] | null
  user?: { id: string; name: string; email: string }
  fetched_at?: string
  cached?: boolean
  stale?: boolean
  closed_count?: number
  warnings?: string[]
  /** A structure summary (no values) of Linear's raw answer, present when something could not be read. */
  diagnostics?: string
}

export type IssueComment = { id: string; author: string; body: string; url: string; created_at: string | null }
export type IssueDetailResult = { issue: IssueSummary; comments: IssueComment[]; comments_total: number; comments_error?: string; fetched_at: string }

export type IssueThreadRequest = {
  target: { kind: 'session' | 'new_session'; session_id?: string; project_id?: string; agent?: string; name?: string }
  subject?: string
  instruction?: string
}
export type IssueThreadPreview = { handoff: string; message: string; text: string; bytes: number; subject: string; agent: string; project: string; warnings: string[] }
/** Which minbox project to start the thread in (source: linked | name | only | llm | none). */

// ---- Slack (personal): the user token, and the threads that need my reply ----

export type SlackBackend = 'auto' | 'rts' | 'legacy'
export type SlackDiag = {
  calls: number
  by_method: Record<string, number>
  errors: number
  rate_limited: number
  last_error: string
  last_error_method?: string
  last_error_at: string | null
  last_call_at: string | null
  rate_limited_until: string | null
  blocked?: Record<string, number>
}
export type SlackProgress = { running: boolean; stage?: string; done: number; total: number; started_at?: string; finished_at?: string; calls: number; partial: boolean; wait_until?: string; error?: string }
export type SlackStatus = {
  connected: boolean
  token_masked?: string
  user_id?: string
  user?: string
  team_id?: string
  team?: string
  team_url?: string
  connected_at?: string
  search_backend: SlackBackend
  search_backend_used?: 'rts' | 'legacy'
  search_backend_note?: string
  scopes: string[]
  scopes_known: boolean
  missing_scopes: string[]
  optional_scopes: string[]
  optional_missing: string[]
  last_test?: string
  last_test_ok: boolean
  last_test_at?: string
  diagnostics: SlackDiag
  days: number
  max_candidates: number
  unverified: string[]
  refresh: SlackProgress
}
export type SlackTestResult = { ok: boolean; message: string; error?: string; code?: string; missing_scopes?: string[]; search?: string }
export type SlackJudgement = { needs_reply: 'yes' | 'maybe' | 'no'; reason: string; urgency: 'high' | 'normal' | 'low'; summary: string; suggested_next_step?: string; source: 'llm' | 'rule'; latest_ts: string }
export type SlackGroup = 'needs_reply' | 'maybe' | 'dismissed'
export type SlackItem = {
  id: string
  channel: string
  thread_ts: string
  group: SlackGroup
  state: 'active' | 'dismissed' | 'snoozed' | 'muted'
  snooze_until?: string
  reappeared?: boolean
  kind: 'channel' | 'dm' | 'group'
  label: string
  people: string[]
  last_ts: string
  last_at: string | null
  last_author: string
  last_is_me: boolean
  snippet: string
  messages: number
  unread: boolean
  permalink: string
  judgement: SlackJudgement | null
  unjudged: boolean
  stale?: boolean
  minbox_thread: IssueThreadRef | null
}
export type SlackListResult = {
  items: SlackItem[]
  counts: Partial<Record<SlackGroup, number>>
  hidden: number
  notes: string[]
  fetched_at: string | null
  refresh: SlackProgress
  user: { id: string; name: string }
  team: string
  backend: 'rts' | 'legacy'
  backend_note: string
}
export type SlackLink = { name: string; url?: string }
export type SlackMessage = { ts: string; at: string; user_id: string; name: string; is_me: boolean; is_bot: boolean; html: string; files: SlackLink[]; attachments: SlackLink[] }
export type SlackThreadDetail = {
  id: string
  channel: string
  thread_ts: string
  kind: 'channel' | 'dm' | 'group'
  label: string
  permalink: string
  messages: SlackMessage[]
  earlier: number
  note: string
  fetched_at: string
  team: string
  me: string
  judgement?: SlackJudgement
  judgement_stale?: boolean
  state?: string
  snooze_until?: string
  minbox_thread?: IssueThreadRef
}

export type ProjectSuggestion = { project_id: string; source: 'linked' | 'name' | 'only' | 'llm' | 'none'; reason: string }

/** Something that happened on the linked issue: a comment, or a compact change (state, title, assignee). */
export type LinearEvent = {
  id: string
  kind: 'comment' | 'state' | 'title' | 'assignee'
  author: string
  body: string
  url: string
  /** Not passed to the agent (the author filter). */
  filtered: boolean
  delivered: boolean
  created_at: string
}

/** A question for the person that helps them reply to the agent (drafted by the helper agent). Every
 *  question also takes a free-text "Other" answer; no options means free text only. */
export type ReplyQuestion = { question: string; kind: 'single' | 'multi'; options: { label: string; description?: string }[] }
/** Reply help for a thread (the server caches it per last message): questions to answer, and a
 *  `!command` the agent was denied that the person may run themselves. */
export type SuggestResult = { questions: ReplyQuestion[]; command?: string; reason?: 'disabled' | 'not_needed' | 'no_agent'; error?: string }

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
  reply_suggestions: true,
  public_url: '',
  default_agent: '',
  linear: { author_filter: 'everyone', allowed_authors: '', include_body: false, thread_link: false, draft_extra_prompt: '' },
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
export type NotifyType = { id: string; label: string; fields: NotifyField[]; /** Setup steps shown under the form, one per line. */ help?: string }
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
  /** Slack app destinations with "Receive messages from Slack" on. */
  receive_status?: ReceiveStatus
}
export type ReceiveStatus = {
  receiving: boolean
  last_poll_at: string | null
  last_poll_ok: boolean | null
  last_poll_error: string
  summary: string
  next_poll_at: string | null
  paused_until: string | null
  interval_seconds: number
  configured_seconds: number
  slowed: boolean
  dm_known: boolean
  delivered: number
  last_delivered_at: string | null
  watched_threads: number
  problems: string[]
  missing_scopes: string[]
}
export type ReceiveCheck = { ran: boolean; busy: boolean; summary: string; status: ReceiveStatus }

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
export type FileEntry = { path: string; dir: boolean }

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

export type ServerEvent = { type: 'sessions' | 'threads' | 'thread' | 'cards' | 'settings' | 'hosts' | 'devices' | 'projects' | 'notifications' | 'linear' | 'slack' | 'open'; session_id?: string; thread_id?: string; url?: string }

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

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const send = () =>
    fetch(path, {
      method,
      signal,
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
  createSession: (cwd: string, name: string, host_id?: string, kind?: SessionKind, agent?: AgentKind) => call<Session>('POST', '/api/sessions', { cwd, name, host_id, kind, agent }),
  /** A session inside a project: its host and folder. */
  createSessionIn: (project_id: string, name: string, kind?: SessionKind, main?: boolean, agent?: AgentKind) => call<Session>('POST', '/api/sessions', { project_id, name, kind, main: main || undefined, agent }),
  agents: (hostId?: string, fresh?: boolean) =>
    call<AgentsInfo>('GET', `/api/agents${hostId ? `?host_id=${encodeURIComponent(hostId)}${fresh ? '&fresh=1' : ''}` : ''}`),
  setMainSession: (project_id: string, session_id: string) => call<Project>('PATCH', `/api/projects/${project_id}`, { main_session_id: session_id }),
  setProjectEmoji: (id: string, emoji: string) => call<Project>('PUT', `/api/projects/${id}/icon`, { emoji }),
  clearProjectIcon: (id: string) => call<Project>('DELETE', `/api/projects/${id}/icon`),
  setProjectImage: async (id: string, file: Blob) => {
    const res = await fetch(`/api/projects/${id}/icon`, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new ApiError(json?.error ?? `upload failed (${res.status})`, res.status)
    return json as Project
  },
  projects: (archived = false) => call<Project[]>('GET', `/api/projects${archived ? '?archived=1' : ''}`),
  createProject: (p: { dir: string; host_id?: string; name?: string }) => call<Project>('POST', '/api/projects', p),
  patchProject: (id: string, p: { name?: string; pinned?: boolean; dir?: string; host_id?: string; default_agent?: AgentKind | '' }) => call<Project>('PATCH', `/api/projects/${id}`, p),
  projectDeletePreview: (id: string) => call<{ sessions: number; running_sessions: number; threads: number; messages: number }>('GET', `/api/projects/${id}/delete-preview`),
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
  sessionConnection: (id: string) => call<ModConnectionInfo>('GET', `/api/sessions/${id}/connection`),
  restartSession: (id: string) => call<Ok>('POST', `/api/sessions/${id}/restart`),
  deleteSession: (id: string) => call<Ok>('DELETE', `/api/sessions/${id}`),
  archiveSession: (id: string) => call<Ok>('POST', `/api/sessions/${id}/archive`),
  unarchiveSession: (id: string) => call<Ok>('POST', `/api/sessions/${id}/unarchive`),
  completions: (id: string) => call<Completions>('GET', `/api/sessions/${id}/completions`),
  files: (id: string, prefix: string) => call<{ entries: FileEntry[] }>('GET', `/api/sessions/${id}/files?prefix=${encodeURIComponent(prefix)}`),

  allThreads: () => call<Thread[]>('GET', '/api/threads'),
  threads: (sessionId: string) => call<Thread[]>('GET', `/api/sessions/${sessionId}/threads`),
  thread: (id: string) => call<Thread>('GET', `/api/threads/${id}`),
  forkPreview: (threadId: string, req: ForkRequest) => call<ForkPreview>('POST', `/api/threads/${threadId}/fork/preview`, req),
  fork: (threadId: string, req: ForkRequest) => call<{ thread: Thread; session: Session }>('POST', `/api/threads/${threadId}/fork`, req),
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
  suggestions: (threadId: string) => call<SuggestResult>('GET', `/api/threads/${threadId}/suggestions`),
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
  checkNotification: (id: string) => call<ReceiveCheck>('POST', `/api/notifications/${id}/check`),
  testNotification: (id: string) => call<{ ok: boolean; error?: string; message?: string }>('POST', `/api/notifications/${id}/test`),
  storage: () => call<Storage>('GET', '/api/storage'),
  clearScratch: () => call<{ removed: number }>('POST', '/api/storage/clear-scratch'),
  about: () => call<About>('GET', '/api/about'),
  linearStatus: () => call<LinearStatus>('GET', '/api/integrations/linear'),
  linearLogin: () => call<{ url: string; redirect_uri: string }>('POST', '/api/integrations/linear/login'),
  linearDisconnect: () => call<LinearStatus>('POST', '/api/integrations/linear/disconnect'),
  linearTest: () => call<{ ok: boolean; error?: string; user?: { name: string; email: string }; tools?: string[] }>('POST', '/api/integrations/linear/test'),
  linkLinear: (threadId: string, issue: string) => call<ThreadLink>('PUT', `/api/threads/${threadId}/linear`, { issue }),
  linearDraft: (threadId: string, stage: 'meta' | 'llm', refresh = false, teamId = '') =>
    call<LinearDraftResult>('POST', `/api/threads/${threadId}/linear/draft`, { stage, ...(refresh ? { refresh: true } : {}), ...(teamId ? { team_id: teamId } : {}) }),
  linearTeamLists: (threadId: string, teamId: string, refresh = false) =>
    call<LinearTeamLists>('POST', `/api/threads/${threadId}/linear/team/${encodeURIComponent(teamId)}/lists`, refresh ? { refresh: true } : {}),
  createLinearIssue: (threadId: string, body: LinearDraft & { submission_id: string }) => call<ThreadLink>('POST', `/api/threads/${threadId}/linear/create`, body),
  issuesList: (opts: { closed?: boolean; refresh?: boolean; cached?: boolean } = {}) =>
    call<IssueListResult>('GET', `/api/linear/issues?assignee=me${opts.closed ? '&closed=1' : ''}${opts.refresh ? '&refresh=1' : ''}${opts.cached ? '&cached=1' : ''}`),
  /** The link dialog's search: an exact identifier (or issue URL) first, then text matches. Empty q: no issues. */
  issueSearch: (q: string, signal?: AbortSignal) => call<{ issues: IssueSummary[]; query: string }>('GET', `/api/linear/search?q=${encodeURIComponent(q)}`, undefined, signal),
  issueGet: (ident: string, refresh = false) => call<IssueDetailResult>('GET', `/api/linear/issues/${encodeURIComponent(ident)}${refresh ? '?refresh=1' : ''}`),
  issueThreadPreview: (ident: string, req: IssueThreadRequest) => call<IssueThreadPreview>('POST', `/api/linear/issues/${encodeURIComponent(ident)}/thread/preview`, req),
  issueStartThread: (ident: string, req: IssueThreadRequest) =>
    call<{ thread: Thread; session: Session; link_error?: string }>('POST', `/api/linear/issues/${encodeURIComponent(ident)}/thread`, req),
  slackStatus: () => call<SlackStatus>('GET', '/api/integrations/slack-user'),
  slackConnect: (token: string) => call<{ result: SlackTestResult; status: SlackStatus }>('PUT', '/api/integrations/slack-user', { token }),
  slackSetBackend: (search_backend: SlackBackend) => call<{ status: SlackStatus }>('PUT', '/api/integrations/slack-user', { search_backend }),
  slackTest: () => call<{ result: SlackTestResult; status: SlackStatus }>('POST', '/api/integrations/slack-user/test'),
  slackDisconnect: () => call<SlackStatus>('POST', '/api/integrations/slack-user/disconnect'),
  slackClearCache: () => call<SlackStatus>('POST', '/api/integrations/slack-user/clear-cache'),
  slackThreads: (opts: { refresh?: boolean; cached?: boolean } = {}) => call<SlackListResult>('GET', `/api/slack/threads?${opts.cached ? 'cached=1' : opts.refresh ? 'refresh=1' : 'x=1'}`),
  slackThread: (id: string, refresh = false) => call<SlackThreadDetail>('GET', `/api/slack/threads/${encodeURIComponent(id)}${refresh ? '?refresh=1' : ''}`),
  slackState: (id: string, action: 'dismiss' | 'mute' | 'snooze' | 'restore', until?: Date) =>
    call<Ok>('POST', `/api/slack/threads/${encodeURIComponent(id)}/state`, { action, ...(until ? { until: until.toISOString() } : {}) }),
  slackProjectSuggestion: (id: string) => call<ProjectSuggestion>('POST', `/api/slack/threads/${encodeURIComponent(id)}/project-suggestion`),
  slackThreadPreview: (id: string, req: IssueThreadRequest) => call<IssueThreadPreview>('POST', `/api/slack/threads/${encodeURIComponent(id)}/thread/preview`, req),
  slackStartThread: (id: string, req: IssueThreadRequest) => call<{ thread: Thread; session: Session; link_error?: string }>('POST', `/api/slack/threads/${encodeURIComponent(id)}/thread`, req),
  issueProjectSuggestion: (ident: string) => call<ProjectSuggestion>('POST', `/api/linear/issues/${encodeURIComponent(ident)}/project-suggestion`),
  issueDraft: (body: { stage: 'meta' | 'llm'; text?: string; team_id?: string; refresh?: boolean; regenerate?: boolean }) =>
    call<LinearDraftResult>('POST', '/api/linear/issues/draft', body),
  issueTeamLists: (teamId: string, refresh = false) => call<LinearTeamLists>('POST', `/api/linear/issues/team/${encodeURIComponent(teamId)}/lists`, refresh ? { refresh: true } : {}),
  createIssue: (body: LinearDraft & { submission_id: string }) => call<{ issue: IssueSummary }>('POST', '/api/linear/issues', body),
  unlinkLinear: (threadId: string) => call<Ok>('DELETE', `/api/threads/${threadId}/linear`),
  refreshLinear: (threadId: string, force = false) =>
    call<{ started: boolean; skipped?: string }>('POST', `/api/threads/${threadId}/linear/refresh${force ? '?force=1' : ''}`),
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

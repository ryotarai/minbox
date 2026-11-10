/**
 * The minbox subagent extension for Pi (@earendil-works/pi-coding-agent 1.x): the tool
 * minbox_subagent. Based on Pi's bundled example (examples/extensions/subagent), reduced to what
 * minbox needs and extended with git worktree isolation for children that write.
 *
 * - Each task runs in its own child process: `pi --mode json -p --no-session -ne -nc --offline
 *   --tools <list> [--model] [--thinking] [--append-system-prompt <role file>] "Task: ..."`. The
 *   child loads no extension (so no minbox_* tools, and no recursion) and no AGENTS.md/CLAUDE.md
 *   unless the task sets `context: true`. The parent reads the child's JSON lines (message_end,
 *   tool_result_end) for the answer and the usage.
 * - The child's environment has no MINBOX_* (the session token, the server file) and no PI_SESSION_*.
 * - A task is read-only by default (read, grep, find, ls). `write: true` gives the child edit, write
 *   and bash, but only inside a new git worktree on a new branch minbox-sub/<id> (based on HEAD of the
 *   task's folder, under $MINBOX_SUBAGENT_DIR or <tmp>/minbox-subagents). When the child is done its
 *   changes are COMMITTED on that branch and the worktree is kept; the result names branch, path,
 *   commit and diffstat so the main agent can review and merge. No changes: the worktree and the
 *   branch are removed. Outside a git repository `write: true` is refused. Pi has no permission
 *   prompts: this isolation (and the tool filter) is the only guard; a child with bash can still run
 *   any command as the user.
 * - Limits: 8 tasks per call, 4 at a time (max_concurrency lowers it), 10 minutes per child
 *   (MINBOX_SUBAGENT_TIMEOUT_MS), 40 KB of output per child. Abort (signal) and timeout send SIGTERM,
 *   then SIGKILL after 5 s; a worktree with changes is still kept, an empty one removed.
 * - minbox.ts must not take a long run for an idle Pi: every child event and a heartbeat call
 *   touchBusy() (busy.ts), and the partial updates are Pi tool_execution_update events.
 *
 * Everything but the default export is written against small interfaces so node --test can drive it
 * with a fake `pi` executable and a temp git repository (subagent.test.ts).
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { touchBusy } from './busy.ts'

export const TOOL_NAME = 'minbox_subagent'
export const MAX_TASKS = 8
export const MAX_CONCURRENCY = 4
export const OUTPUT_CAP = 40 * 1024
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
export const KILL_GRACE_MS = 5000
const HEARTBEAT_MS = 15_000
export const READ_TOOLS = ['read', 'grep', 'find', 'ls']
export const WRITE_TOOLS = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash']
/** Tools that can change something: never given to a child without write: true. */
const MUTATING = new Set(['edit', 'write', 'bash'])
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

// ---- types ----

export type Task = { task: string; role?: string; model?: string; thinking?: string; tools?: string[]; cwd?: string; write?: boolean; context?: boolean }
export type Params = { tasks: Task[]; max_concurrency?: number }

export type AgentDef = { name: string; description: string; tools?: string[]; model?: string; systemPrompt: string; source: 'builtin' | 'user' | 'project'; filePath: string }

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }

export type WorktreeInfo = {
  path: string
  branch: string
  base: string
  commit?: string
  diffstat?: string
  /** true if the worktree and branch were removed because the child changed nothing. */
  removed: boolean
}

export type ChildResult = {
  index: number
  role?: string
  task: string
  status: 'ok' | 'error' | 'aborted' | 'timeout'
  exitCode: number | null
  output: string
  truncated: boolean
  stderr: string
  usage: Usage
  model?: string
  stopReason?: string
  errorMessage?: string
  tools: string[]
  cwd: string
  notes: string[]
  worktree?: WorktreeInfo
  durationMs: number
}

export type GitResult = { code: number; stdout: string; stderr: string }
export type Git = (args: string[], cwd: string) => Promise<GitResult>

/** What the extension needs from the outside; replaced in tests. */
export type Deps = {
  env: Record<string, string | undefined>
  git: Git
  /** The command and arguments that start a child Pi with these arguments. */
  piInvocation: (args: string[]) => { command: string; args: string[] }
  now: () => number
  /** Where worktrees go. */
  worktreeRoot: string
  agentDirs: (cwd: string) => { user: string; project: string | null; builtin: string }
  killGraceMs: number
  heartbeatMs: number
  randomId: () => string
}

// ---- agent definitions ----

/** Frontmatter of an agent markdown file: `key: value` lines between two `---` lines. */
export function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const text = content.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return { meta: {}, body: text }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (m) meta[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  const rest = text.slice(end + 4)
  return { meta, body: rest.replace(/^[^\n]*\n?/, '').replace(/^\n+/, '') }
}

/** `read, grep` or `[read, grep]` to a list; empty to undefined. */
export function parseToolList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const tools = value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  return tools.length ? tools : undefined
}

export function parseAgent(content: string, source: AgentDef['source'], filePath: string): AgentDef | null {
  const { meta, body } = parseFrontmatter(content)
  if (!meta.name || !meta.description) return null
  return { name: meta.name, description: meta.description, tools: parseToolList(meta.tools), model: meta.model || undefined, systemPrompt: body, source, filePath }
}

export function loadAgentsFromDir(dir: string | null, source: AgentDef['source']): AgentDef[] {
  if (!dir) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: AgentDef[] = []
  for (const n of names.sort()) {
    if (!n.endsWith('.md')) continue
    try {
      const a = parseAgent(readFileSync(join(dir, n), 'utf8'), source, join(dir, n))
      if (a) out.push(a)
    } catch {
      /* one bad file must not hide the others */
    }
  }
  return out
}

/** The nearest `.pi/agents` folder from cwd upwards, or null. */
export function findProjectAgentsDir(cwd: string): string | null {
  let dir = resolve(cwd)
  for (;;) {
    const c = join(dir, '.pi', 'agents')
    try {
      if (statSync(c).isDirectory()) return c
    } catch {
      /* none here */
    }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** Shipped roles, then the user's, then the project's: a later one with the same name replaces. */
export function discoverAgents(dirs: { builtin: string; user: string; project: string | null }): Map<string, AgentDef> {
  const m = new Map<string, AgentDef>()
  for (const a of [...loadAgentsFromDir(dirs.builtin, 'builtin'), ...loadAgentsFromDir(dirs.user, 'user'), ...loadAgentsFromDir(dirs.project, 'project')]) m.set(a.name, a)
  return m
}

// ---- parameters, tools, argv, env ----

/** Checks the parameters; returns an error text or null. */
export function validateParams(p: any, roles: Map<string, AgentDef>): string | null {
  if (!p || !Array.isArray(p.tasks) || p.tasks.length === 0) return 'tasks is required: a non-empty array of {task, role?, model?, thinking?, tools?, cwd?, write?}.'
  if (p.tasks.length > MAX_TASKS) return `At most ${MAX_TASKS} tasks per call (got ${p.tasks.length}). Split them over several calls.`
  if (p.max_concurrency !== undefined && !(Number.isInteger(p.max_concurrency) && p.max_concurrency >= 1)) return 'max_concurrency must be a positive integer.'
  for (let i = 0; i < p.tasks.length; i++) {
    const t = p.tasks[i]
    const at = `tasks[${i}]`
    if (!t || typeof t !== 'object') return `${at} must be an object.`
    if (typeof t.task !== 'string' || !t.task.trim()) return `${at}.task is required: say what the child should do, in full (it sees nothing of this conversation).`
    if (t.role !== undefined && (typeof t.role !== 'string' || !roles.has(t.role))) return `${at}.role "${t.role}" is unknown. Available: ${[...roles.keys()].join(', ') || 'none'}.`
    if (t.thinking !== undefined && !THINKING_LEVELS.includes(t.thinking)) return `${at}.thinking must be one of ${THINKING_LEVELS.join(', ')}.`
    if (t.model !== undefined && (typeof t.model !== 'string' || !t.model.trim() || t.model.startsWith('-'))) return `${at}.model must be a model pattern such as provider/id.`
    if (t.tools !== undefined && (!Array.isArray(t.tools) || t.tools.some((x: unknown) => typeof x !== 'string' || !/^[\w*.-]+$/.test(x)))) return `${at}.tools must be a list of tool names.`
    if (t.cwd !== undefined && typeof t.cwd !== 'string') return `${at}.cwd must be a string.`
    for (const k of ['write', 'context']) if (t[k] !== undefined && typeof t[k] !== 'boolean') return `${at}.${k} must be a boolean.`
  }
  return null
}

/**
 * The child's tool list: the task's own, else the role's, else read-only (read-write for write:true).
 * Without write:true the tools that can change something are dropped, whoever asked for them.
 */
export function resolveTools(task: Task, role: AgentDef | undefined): { tools: string[]; notes: string[] } {
  const notes: string[] = []
  let tools = task.tools && task.tools.length ? task.tools : role?.tools && role.tools.length ? role.tools : task.write ? WRITE_TOOLS : READ_TOOLS
  if (!task.write) {
    const kept = tools.filter((t) => !MUTATING.has(t))
    if (kept.length !== tools.length) notes.push(`read-only: ${tools.filter((t) => MUTATING.has(t)).join(', ')} not available without write: true`)
    tools = kept.length ? kept : READ_TOOLS
  }
  return { tools: [...new Set(tools)], notes }
}

export function buildChildArgs(o: { tools: string[]; model?: string; thinking?: string; promptFile?: string; context?: boolean; task: string }): string[] {
  const args = ['--mode', 'json', '-p', '--no-session', '-ne', '--offline']
  if (!o.context) args.push('-nc')
  args.push('--tools', o.tools.join(','))
  if (o.model) args.push('--model', o.model)
  if (o.thinking) args.push('--thinking', o.thinking)
  if (o.promptFile) args.push('--append-system-prompt', o.promptFile)
  args.push(`Task: ${o.task}`)
  return args
}

/** The environment of a child: the parent's without MINBOX_* and PI_SESSION_*. */
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || k.startsWith('MINBOX_') || k.startsWith('PI_SESSION_')) continue
    out[k] = v
  }
  return out
}

/** Cuts text to at most `cap` bytes of UTF-8 (on a character boundary) and says how much went. */
export function truncateOutput(text: string, cap = OUTPUT_CAP): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= cap) return { text, truncated: false }
  let cut = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8')
  if (cut.endsWith('�')) cut = cut.slice(0, -1)
  const omitted = bytes - Buffer.byteLength(cut, 'utf8')
  return { text: `${cut}\n\n[Output truncated: ${omitted} bytes omitted.]`, truncated: true }
}

export function timeoutOf(env: Record<string, string | undefined>): number {
  const n = Number(env.MINBOX_SUBAGENT_TIMEOUT_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 })

export function addUsage(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, cost: a.cost + b.cost, turns: a.turns + b.turns }
}

// ---- reading a child's JSON lines ----

type Msg = { role?: string; content?: any[]; usage?: any; model?: string; stopReason?: string; errorMessage?: string }

export type ChildState = { messages: Msg[]; usage: Usage; model?: string; stopReason?: string; errorMessage?: string }

export const newChildState = (): ChildState => ({ messages: [], usage: emptyUsage() })

export function finalText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
      if (text) return text
    }
  }
  return ''
}

/** Applies one line of the child's stdout; true if it was an event that changed the state. */
export function applyLine(state: ChildState, line: string): boolean {
  if (!line.trim()) return false
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return false
  }
  if (ev?.type === 'message_end' && ev.message) {
    const msg = ev.message as Msg
    state.messages.push(msg)
    if (msg.role === 'assistant') {
      state.usage.turns++
      const u = msg.usage
      if (u) {
        state.usage.input += u.input || 0
        state.usage.output += u.output || 0
        state.usage.cacheRead += u.cacheRead || 0
        state.usage.cacheWrite += u.cacheWrite || 0
        state.usage.cost += u.cost?.total || 0
      }
      if (!state.model && msg.model) state.model = msg.model
      if (msg.stopReason) state.stopReason = msg.stopReason
      if (msg.errorMessage) state.errorMessage = msg.errorMessage
    }
    return true
  }
  if (ev?.type === 'tool_result_end' && ev.message) {
    state.messages.push(ev.message as Msg)
    return true
  }
  return false
}

// ---- git worktrees ----

export function realGit(): Git {
  return (args, cwd) =>
    new Promise((res) => {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'].includes(k)) env[k] = v
      env.GIT_TERMINAL_PROMPT = '0'
      execFile('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
        res({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (err ? String(err) : '')) })
      })
    })
}

export type Worktree = { path: string; childCwd: string; branch: string; base: string; repoRoot: string }

/**
 * Creates a worktree for a writing child: a new branch minbox-sub/<id> at HEAD of `cwd`'s repository,
 * checked out under `root`. Throws a clear error outside a git repository or without a commit.
 * The user's checkout is only read (rev-parse); `worktree add` writes the new folder and the
 * repository's worktree metadata.
 */
export async function createWorktree(git: Git, o: { cwd: string; root: string; id: string }): Promise<Worktree> {
  const top = await git(['rev-parse', '--show-toplevel'], o.cwd)
  if (top.code !== 0) throw new Error(`write: true needs a git repository, and ${o.cwd} is not inside one. Run the task read-only, or give it a cwd inside a repository.`)
  const repoRoot = realpathSync(top.stdout.trim())
  const head = await git(['rev-parse', '--verify', 'HEAD'], o.cwd)
  if (head.code !== 0) throw new Error(`write: true needs a repository with at least one commit (${repoRoot} has none).`)
  const base = head.stdout.trim()
  const branch = `minbox-sub/${o.id}`
  mkdirSync(o.root, { recursive: true })
  const path = join(o.root, `${basename(repoRoot).replace(/[^\w.-]+/g, '_')}-${o.id}`)
  const add = await git(['worktree', 'add', '-q', '-b', branch, path, base], repoRoot)
  if (add.code !== 0) throw new Error(`could not create the worktree: ${(add.stderr || add.stdout).trim()}`)
  const rel = relative(repoRoot, realpathSync(o.cwd))
  const childCwd = rel && !rel.startsWith('..') ? join(path, rel) : path
  return { path, childCwd, branch, base, repoRoot }
}

const COMMITTER = ['-c', 'user.name=minbox-subagent', '-c', 'user.email=minbox-subagent@localhost', '-c', 'commit.gpgsign=false']

/**
 * After the child: if it changed anything (uncommitted, or commits of its own) the changes are
 * committed on the branch and the worktree is kept; otherwise worktree and branch are removed.
 */
export async function finishWorktree(git: Git, wt: Worktree, message: string): Promise<WorktreeInfo> {
  const info: WorktreeInfo = { path: wt.path, branch: wt.branch, base: wt.base, removed: false }
  try {
    const st = await git(['status', '--porcelain'], wt.path)
    if (st.code === 0 && st.stdout.trim()) {
      await git(['add', '-A'], wt.path)
      const c = await git([...COMMITTER, 'commit', '--no-verify', '-q', '-m', message], wt.path)
      if (c.code !== 0) throw new Error(`commit failed: ${(c.stderr || c.stdout).trim()}`)
    }
    const head = await git(['rev-parse', 'HEAD'], wt.path)
    const commit = head.stdout.trim()
    if (head.code === 0 && commit && commit !== wt.base) {
      info.commit = commit
      const ds = await git(['diff', '--stat', `${wt.base}..${commit}`], wt.path)
      info.diffstat = ds.stdout.trim()
      return info
    }
  } catch (err) {
    // Could not tell what is in there: keep it rather than lose work.
    info.diffstat = `(could not inspect the worktree: ${String(err)})`
    return info
  }
  await removeWorktree(git, wt)
  info.removed = true
  return info
}

export async function removeWorktree(git: Git, wt: Worktree): Promise<void> {
  await git(['worktree', 'remove', '--force', wt.path], wt.repoRoot)
  try {
    rmSync(wt.path, { recursive: true, force: true })
  } catch {
    /* gone already */
  }
  await git(['worktree', 'prune'], wt.repoRoot)
  await git(['branch', '-D', wt.branch], wt.repoRoot)
}

// ---- running a child ----

export type Killer = () => void

type RunCtx = {
  deps: Deps
  signal?: AbortSignal
  timeoutMs: number
  defaults: { model?: string; thinking?: string }
  roles: Map<string, AgentDef>
  baseCwd: string
  /** Called on every sign of life from a child. */
  alive: () => void
  /** Called after the child's state changed (for partial updates). */
  changed: () => void
  /** Registers a function that stops the child hard (parent exit). */
  track: (kill: Killer) => () => void
}

function tail(s: string, n: number): string {
  return s.length > n ? '…' + s.slice(-n) : s
}

export async function runChild(ctx: RunCtx, index: number, t: Task, progress: ChildResult): Promise<ChildResult> {
  const { deps } = ctx
  const started = deps.now()
  const role = t.role ? ctx.roles.get(t.role) : undefined
  const { tools, notes } = resolveTools(t, role)
  const cwd = resolve(ctx.baseCwd, t.cwd ?? '.')
  Object.assign(progress, { tools, notes, cwd, status: 'ok' as const })
  const fail = (msg: string): ChildResult => Object.assign(progress, { status: 'error' as const, exitCode: 1, errorMessage: msg, output: msg, durationMs: deps.now() - started })

  let st: any
  try {
    st = statSync(cwd)
  } catch {
    return fail(`cwd does not exist: ${cwd}`)
  }
  if (!st.isDirectory()) return fail(`cwd is not a directory: ${cwd}`)
  if (ctx.signal?.aborted) return Object.assign(progress, { status: 'aborted' as const, exitCode: null, output: 'aborted before it started', durationMs: 0 })

  let wt: Worktree | null = null
  let promptDir: string | null = null
  const state = newChildState()
  let stderr = ''
  let timedOut = false
  let aborted = false
  let exitCode: number | null = null
  try {
    let runCwd = cwd
    if (t.write) {
      try {
        wt = await createWorktree(deps.git, { cwd, root: deps.worktreeRoot, id: `${deps.randomId()}-${index + 1}` })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
      runCwd = wt.childCwd
      progress.worktree = { path: wt.path, branch: wt.branch, base: wt.base, removed: false }
    }
    let promptFile: string | undefined
    if (role?.systemPrompt.trim()) {
      promptDir = mkdtempSync(join(tmpdir(), 'minbox-subagent-'))
      promptFile = join(promptDir, `prompt-${role.name.replace(/[^\w.-]+/g, '_')}.md`)
      writeFileSync(promptFile, role.systemPrompt, { mode: 0o600 })
    }
    const model = t.model ?? role?.model ?? ctx.defaults.model
    const thinking = t.thinking ?? (t.model || role?.model ? undefined : ctx.defaults.thinking)
    progress.model = model
    const args = buildChildArgs({ tools, model, thinking, promptFile, context: t.context, task: t.task })
    const inv = deps.piInvocation(args)

    exitCode = await new Promise<number | null>((done) => {
      const proc = spawn(inv.command, inv.args, { cwd: runCwd, env: scrubEnv(deps.env), shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      let exited = false
      let buf = ''
      let killTimer: ReturnType<typeof setTimeout> | null = null
      const stop = (why: 'abort' | 'timeout') => {
        if (exited) return
        if (why === 'abort') aborted = true
        else timedOut = true
        proc.kill('SIGTERM')
        killTimer ??= setTimeout(() => {
          if (!exited) proc.kill('SIGKILL')
        }, deps.killGraceMs)
      }
      const untrack = ctx.track(() => {
        if (!exited) proc.kill('SIGKILL')
      })
      const timer = setTimeout(() => stop('timeout'), ctx.timeoutMs)
      const onAbort = () => stop('abort')
      if (ctx.signal) {
        if (ctx.signal.aborted) onAbort()
        else ctx.signal.addEventListener('abort', onAbort, { once: true })
      }
      const line = (l: string) => {
        if (applyLine(state, l)) {
          progress.usage = { ...state.usage }
          progress.output = finalText(state.messages)
          ctx.alive()
          ctx.changed()
        } else if (l.trim()) ctx.alive()
      }
      proc.stdout!.on('data', (d) => {
        buf += d.toString()
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const l of lines) line(l)
      })
      proc.stderr!.on('data', (d) => {
        stderr = tail(stderr + d.toString(), 8192)
      })
      const end = (code: number | null) => {
        if (exited) return
        exited = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        ctx.signal?.removeEventListener('abort', onAbort)
        untrack()
        if (buf.trim()) line(buf)
        done(code)
      }
      proc.on('close', end)
      proc.on('error', (e) => {
        stderr += `\n${String(e)}`
        end(1)
      })
    })
  } finally {
    if (promptDir) rmSync(promptDir, { recursive: true, force: true })
  }

  const final = finalText(state.messages)
  const failed = exitCode !== 0 || state.stopReason === 'error' || state.stopReason === 'aborted'
  const status: ChildResult['status'] = timedOut ? 'timeout' : aborted ? 'aborted' : failed ? 'error' : 'ok'
  let text = final
  if (status === 'timeout') text = `timed out after ${Math.round(ctx.timeoutMs / 1000)} s${final ? `\nlast message:\n${final}` : ''}`
  else if (status === 'aborted') text = `aborted${final ? `\nlast message:\n${final}` : ''}`
  else if (failed) text = state.errorMessage || stderr.trim() || final || '(no output)'
  else if (!text) text = '(no output)'
  const cut = truncateOutput(text)
  Object.assign(progress, {
    status,
    exitCode,
    output: cut.text,
    truncated: cut.truncated,
    stderr: failed ? stderr.trim() : '',
    usage: { ...state.usage },
    model: state.model ?? progress.model,
    stopReason: state.stopReason,
    errorMessage: state.errorMessage,
    durationMs: deps.now() - started,
  })
  if (wt) {
    try {
      progress.worktree = await finishWorktree(deps.git, wt, `minbox subagent: ${t.task.split('\n')[0].slice(0, 72)}`)
    } catch (err) {
      progress.notes.push(`worktree cleanup failed: ${String(err)} (${wt.path}, branch ${wt.branch})`)
    }
  }
  return progress
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  })
  await Promise.all(workers)
}

// ---- the result text ----

export function resultText(results: ChildResult[]): string {
  const one = results.length === 1
  const parts = results.map((r) => {
    const head = `${one ? '' : `## Task ${r.index + 1}${r.role ? ` (${r.role})` : ''}: `}${r.status}`
    const lines = [head]
    if (r.notes.length) lines.push(`[${r.notes.join('; ')}]`)
    lines.push(r.output)
    const w = r.worktree
    if (w) {
      if (w.removed) lines.push('\n[worktree: no changes; the worktree and its branch were removed]')
      else {
        lines.push(
          '',
          `[worktree kept] branch: ${w.branch}${w.commit ? `  commit: ${w.commit.slice(0, 12)}` : ''}  base: ${w.base.slice(0, 12)}`,
          `path: ${w.path}`,
          ...(w.diffstat ? ['diffstat:', w.diffstat] : []),
          `review: git diff ${w.base.slice(0, 12)}..${w.branch}; merge: git merge ${w.branch}; afterwards: git worktree remove ${w.path} && git branch -d ${w.branch}`,
        )
      }
    }
    return lines.join('\n')
  })
  const total = results.reduce((u, r) => addUsage(u, r.usage), emptyUsage())
  const ok = results.filter((r) => r.status === 'ok').length
  const footer = results.length > 1 ? `\n\n${ok}/${results.length} tasks ok. usage: ${total.turns} turns, in ${total.input}, out ${total.output}, cache r${total.cacheRead}/w${total.cacheWrite}, $${total.cost.toFixed(4)}` : ''
  return parts.join('\n\n') + footer
}

// ---- the tool ----

export const DESCRIPTION = [
  'Delegate work to subagents: separate Pi processes with their own context, run in parallel (up to 8 tasks, 4 at a time).',
  'Each task: {task, role?, model?, thinking?, tools?, cwd?, write?, context?}. A child sees nothing of this conversation, so put everything it needs into `task`.',
  'role picks a prepared system prompt: scout (recon), planner, reviewer (read-only), worker; the user may add roles in ~/.pi/agent/agents and the project in .pi/agents.',
  'Children are read-only (read, grep, find, ls) by default and have no minbox_* tools.',
  'write: true lets the child change files, only inside its own git worktree on a new branch minbox-sub/<id> (needs a git repository). Its changes are committed on that branch and the result names the branch, path and diffstat for you to review and merge; a child that changed nothing leaves no worktree.',
  'Children inherit your model and thinking level unless the role or task sets them. context: true also loads AGENTS.md/CLAUDE.md for the child.',
].join(' ')

export const SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TASKS,
      description: `1 to ${MAX_TASKS} tasks, run in parallel (at most max_concurrency at a time).`,
      items: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'What the child should do, in full: goal, files, constraints, how to verify, what to report.' },
          role: { type: 'string', description: 'A role name: scout, planner, reviewer, worker, or one from ~/.pi/agent/agents or .pi/agents.' },
          model: { type: 'string', description: 'Model pattern (provider/id); default: the role\'s, else this session\'s.' },
          thinking: { type: 'string', enum: THINKING_LEVELS, description: 'Thinking level; default: this session\'s.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Tool allowlist; default read,grep,find,ls (read-only). Edit, write and bash are dropped unless write is true.' },
          cwd: { type: 'string', description: 'Working folder (default: this session\'s). With write, the worktree is made from this folder\'s repository.' },
          write: { type: 'boolean', description: 'Let the child change files in its own git worktree on a new branch (committed there; you merge it). Default false.' },
          context: { type: 'boolean', description: 'Load AGENTS.md / CLAUDE.md for the child. Default false.' },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
    max_concurrency: { type: 'integer', minimum: 1, maximum: MAX_CONCURRENCY, description: `How many children at once (default and maximum ${MAX_CONCURRENCY}).` },
  },
  required: ['tasks'],
  additionalProperties: false,
} as const

export function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1]
  if (script && !script.startsWith('/$bunfs/root/') && existsSync(script)) return { command: process.execPath, args: [script, ...args] }
  const exec = basename(process.execPath).toLowerCase()
  if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args }
  return { command: 'pi', args }
}

function hereDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return typeof __dirname === 'string' ? __dirname : '.'
  }
}

export function realDeps(): Deps {
  const env = process.env
  return {
    env,
    git: realGit(),
    piInvocation,
    now: () => Date.now(),
    worktreeRoot: env.MINBOX_SUBAGENT_DIR || join(tmpdir(), 'minbox-subagents'),
    agentDirs: (cwd) => ({
      builtin: join(hereDir(), 'agents'),
      user: join(env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'agents'),
      project: findProjectAgentsDir(cwd),
    }),
    killGraceMs: KILL_GRACE_MS,
    heartbeatMs: HEARTBEAT_MS,
    randomId: () => Date.now().toString(36) + '-' + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(2)), (x) => x.toString(16).padStart(2, '0')).join(''),
  }
}

/** Hard stops of the running children, for Pi shutting down or this process exiting. */
const allKillers = new Set<Killer>()
let exitHooked = false
function killAllChildren(): void {
  for (const k of [...allKillers]) {
    try {
      k()
    } catch {
      /* gone */
    }
  }
}

export default function (pi: any): void {
  install(pi, realDeps())
}

export function install(pi: any, deps: Deps): { killAll(): void } {
  const killers = allKillers
  const killAll = killAllChildren
  if (!exitHooked) {
    exitHooked = true
    process.once('exit', killAllChildren)
  }
  pi.on?.('session_shutdown', async () => killAll())

  pi.registerTool({
    name: TOOL_NAME,
    label: 'minbox: subagents',
    description: DESCRIPTION,
    parameters: SCHEMA,
    async execute(_id: string, params: Params, signal: AbortSignal | undefined, onUpdate: ((r: any) => void) | undefined, ctx: any) {
      const baseCwd: string = ctx?.cwd || process.cwd()
      const roles = discoverAgents(deps.agentDirs(baseCwd))
      const bad = validateParams(params, roles)
      if (bad) throw new Error(bad)

      const defaults = {
        model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking: (typeof pi.getThinkingLevel === 'function' ? pi.getThinkingLevel() : undefined) ?? ctx?.thinkingLevel,
      }
      const results: ChildResult[] = params.tasks.map((t, index) => ({
        index,
        role: t.role,
        task: t.task.slice(0, 200),
        status: 'ok',
        exitCode: null,
        output: '',
        truncated: false,
        stderr: '',
        usage: emptyUsage(),
        tools: [],
        cwd: baseCwd,
        notes: [],
        durationMs: 0,
      }))
      const running = new Set<number>()
      const done = new Set<number>()
      const snapshot = () => {
        const total = results.reduce((u, r) => addUsage(u, r.usage), emptyUsage())
        return {
          content: [{ type: 'text', text: `subagents: ${done.size}/${results.length} done, ${running.size} running` }],
          details: { results: results.map((r) => ({ ...r })), usage: total, running: [...running], done: [...done] },
        }
      }
      const alive = () => touchBusy()
      const changed = () => {
        alive()
        onUpdate?.(snapshot())
      }
      const heartbeat = setInterval(() => {
        alive()
        onUpdate?.(snapshot())
      }, deps.heartbeatMs)
      heartbeat.unref?.()
      const run: RunCtx = {
        deps,
        signal,
        timeoutMs: timeoutOf(deps.env),
        defaults,
        roles,
        baseCwd,
        alive,
        changed,
        track: (k) => {
          killers.add(k)
          return () => killers.delete(k)
        },
      }
      const limit = Math.min(MAX_CONCURRENCY, params.max_concurrency ?? MAX_CONCURRENCY)
      alive()
      try {
        await mapLimit(params.tasks, limit, async (t, i) => {
          running.add(i)
          changed()
          try {
            await runChild(run, i, t, results[i])
          } catch (err) {
            Object.assign(results[i], { status: 'error', exitCode: 1, output: `subagent failed: ${err instanceof Error ? err.message : String(err)}` })
          } finally {
            running.delete(i)
            done.add(i)
            changed()
          }
        })
      } finally {
        clearInterval(heartbeat)
        alive()
      }
      const total = results.reduce((u, r) => addUsage(u, r.usage), emptyUsage())
      return { content: [{ type: 'text', text: resultText(results) }], details: { results, usage: total } }
    },
  })
  return { killAll }
}

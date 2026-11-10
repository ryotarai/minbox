// Tests of the subagent extension: the pure parts, git worktree handling against a temp repository,
// and whole tool calls against a fake `pi` executable that prints canned JSON lines.
// Run: node --test plugin/pi/subagent.test.ts   (Node 22.18+ strips the types itself)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { busySeq } from './busy.ts'
import {
  buildChildArgs,
  createWorktree,
  discoverAgents,
  finishWorktree,
  install,
  loadAgentsFromDir,
  parseAgent,
  parseFrontmatter,
  parseToolList,
  realDeps,
  realGit,
  resolveTools,
  scrubEnv,
  timeoutOf,
  truncateOutput,
  validateParams,
  type Deps,
} from './subagent.ts'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)))
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function repo(): string {
  const dir = tmp('sub-repo-')
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 't')
  sh(dir, 'config', 'user.email', 't@t')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, 'sub', 'b.txt'), 'b\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

// A fake pi: what it does is chosen by words in the task. It logs "start"/"end" lines to $FAKE_LOG.
const FAKE = `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
const task = args[args.length - 1]
const log = (s) => process.env.FAKE_LOG && fs.appendFileSync(process.env.FAKE_LOG, s + '\\n')
const emit = (text, extra = {}) => console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], model: 'fake/m', stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } }, ...extra } }))
log('start ' + task)
const finish = (code) => { log('end ' + task); process.stdout.write('', () => process.exit(code)) }
if (task.includes('HANG')) { process.on('SIGTERM', () => { if (!task.includes('STUBBORN')) finish(143) }); emit('thinking'); setInterval(() => {}, 1000) }
else if (task.includes('SLOW')) setTimeout(() => { emit('slow done'); finish(0) }, 150)
else {
  if (task.includes('WRITE')) fs.writeFileSync('written.txt', 'hello\\n')
  if (task.includes('ENVKEYS')) emit(Object.keys(process.env).filter((k) => /^(MINBOX_|PI_SESSION_)/.test(k)).join(',') || 'none')
  else if (task.includes('ARGS')) emit(JSON.stringify(args) + ' cwd=' + process.cwd())
  else if (task.includes('BIG')) emit('x'.repeat(100000))
  else if (task.includes('FAIL')) { emit('', { stopReason: 'error', errorMessage: 'model said no' }); finish(1) }
  else emit('done: ' + task)
  finish(0)
}
`

function setup(opts: { env?: Record<string, string>; timeoutMs?: number; killGraceMs?: number; heartbeatMs?: number } = {}) {
  const root = tmp('sub-root-')
  const fake = join(root, 'fake-pi.js')
  writeFileSync(fake, FAKE)
  chmodSync(fake, 0o755)
  const log = join(root, 'fake.log')
  const deps: Deps = {
    ...realDeps(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_LOG: log, ...(opts.env ?? {}) },
    piInvocation: (args) => ({ command: process.execPath, args: [fake, ...args] }),
    worktreeRoot: join(root, 'wt'),
    agentDirs: () => ({ builtin: join(here, 'agents'), user: join(root, 'no-user-agents'), project: null }),
    killGraceMs: opts.killGraceMs ?? 200,
    heartbeatMs: opts.heartbeatMs ?? 60_000,
  }
  const tools = new Map<string, any>()
  const handlers = new Map<string, Function>()
  const pi = { registerTool: (t: any) => tools.set(t.name, t), on: (e: string, h: Function) => handlers.set(e, h) }
  const ext = install(pi, deps)
  const call = (params: any, o: { signal?: AbortSignal; cwd?: string; onUpdate?: (r: any) => void } = {}) =>
    tools.get('minbox_subagent').execute('id', params, o.signal, o.onUpdate, { cwd: o.cwd ?? root, model: { provider: 'fake', id: 'm' } })
  return { root, log, deps, tools, handlers, ext, call }
}

// ---- pure parts ----

test('frontmatter, tool lists and agent definitions', () => {
  const md = '---\nname: x\ndescription: "Does x"\ntools: read, grep\nmodel: p/m\n---\n\nBody line\n'
  const { meta, body } = parseFrontmatter(md)
  assert.equal(meta.name, 'x')
  assert.equal(meta.description, 'Does x')
  assert.equal(body, 'Body line\n')
  assert.deepEqual(parseToolList('read, grep'), ['read', 'grep'])
  assert.deepEqual(parseToolList('[read, "ls"]'), ['read', 'ls'])
  assert.equal(parseToolList(''), undefined)
  const a = parseAgent(md, 'user', '/x.md')!
  assert.deepEqual([a.name, a.model, a.tools, a.source], ['x', 'p/m', ['read', 'grep'], 'user'])
  assert.equal(parseAgent('no frontmatter', 'user', '/y.md'), null)
  assert.equal(parseAgent('---\nname: only\n---\nbody', 'user', '/y.md'), null)
})

test('the shipped roles load; scout, planner and reviewer cannot write; user and project roles override in order', () => {
  const builtin = discoverAgents({ builtin: join(here, 'agents'), user: '/nope', project: null })
  assert.deepEqual([...builtin.keys()].sort(), ['planner', 'reviewer', 'scout', 'worker'])
  for (const n of ['scout', 'planner', 'reviewer']) assert.deepEqual(builtin.get(n)!.tools, ['read', 'grep', 'find', 'ls'])
  assert.ok(builtin.get('worker')!.tools!.includes('edit'))
  for (const a of builtin.values()) assert.ok(a.systemPrompt.trim().length > 20, a.name)

  const u = tmp('sub-u-')
  const p = tmp('sub-p-')
  writeFileSync(join(u, 'scout.md'), '---\nname: scout\ndescription: user scout\n---\nU')
  writeFileSync(join(p, 'scout.md'), '---\nname: scout\ndescription: project scout\n---\nP')
  writeFileSync(join(p, 'broken.md'), '---\nname: nodesc\n---\n')
  const m = discoverAgents({ builtin: join(here, 'agents'), user: u, project: p })
  assert.equal(m.get('scout')!.description, 'project scout')
  assert.equal(m.get('scout')!.source, 'project')
  assert.equal(m.has('nodesc'), false)
  assert.deepEqual(loadAgentsFromDir(null, 'user'), [])
})

test('tools: read-only by default, mutating tools dropped without write, all for write', () => {
  assert.deepEqual(resolveTools({ task: 't' }, undefined).tools, ['read', 'grep', 'find', 'ls'])
  assert.deepEqual(resolveTools({ task: 't', write: true }, undefined).tools, ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'])
  const worker = { name: 'w', description: 'd', tools: ['read', 'edit', 'bash'], systemPrompt: '', source: 'builtin', filePath: '' } as const
  const ro = resolveTools({ task: 't' }, worker)
  assert.deepEqual(ro.tools, ['read'])
  assert.match(ro.notes[0], /write: true/)
  assert.deepEqual(resolveTools({ task: 't', write: true }, worker).tools, ['read', 'edit', 'bash'])
  assert.deepEqual(resolveTools({ task: 't', tools: ['bash', 'grep'] }, undefined).tools, ['grep'])
  assert.deepEqual(resolveTools({ task: 't', tools: ['bash'] }, undefined).tools, ['read', 'grep', 'find', 'ls'])
})

test('child argv: json, no session, no extensions, offline, tool list, task last', () => {
  const a = buildChildArgs({ tools: ['read', 'ls'], model: 'p/m', thinking: 'high', promptFile: '/tmp/p.md', task: '-weird task' })
  assert.deepEqual(a, ['--mode', 'json', '-p', '--no-session', '-ne', '--offline', '-nc', '--tools', 'read,ls', '--model', 'p/m', '--thinking', 'high', '--append-system-prompt', '/tmp/p.md', 'Task: -weird task'])
  const b = buildChildArgs({ tools: ['read'], context: true, task: 't' })
  assert.equal(b.includes('-nc'), false)
  assert.equal(b.includes('--model'), false)
})

test('the child environment has no MINBOX_* and no PI_SESSION_*', () => {
  const env = scrubEnv({ PATH: '/bin', MINBOX_TOKEN: 't', MINBOX_SERVER_FILE: 'f', MINBOX_ANYTHING: 'x', PI_SESSION_ID: 's', PI_SESSION_FILE: 'f', PI_CODING_AGENT_DIR: '/d', HOME: '/h', UNSET: undefined })
  assert.deepEqual(env, { PATH: '/bin', PI_CODING_AGENT_DIR: '/d', HOME: '/h' })
})

test('truncation cuts on a character boundary and says what was omitted', () => {
  assert.deepEqual(truncateOutput('short', 100), { text: 'short', truncated: false })
  const r = truncateOutput('あ'.repeat(100), 10)
  assert.equal(r.truncated, true)
  assert.match(r.text, /^あああ\n\n\[Output truncated: 291 bytes omitted\.\]$/)
  assert.ok(Buffer.byteLength(truncateOutput('x'.repeat(100_000)).text) < 41 * 1024)
})

test('timeout from the environment; parameter validation', () => {
  assert.equal(timeoutOf({}), 600_000)
  assert.equal(timeoutOf({ MINBOX_SUBAGENT_TIMEOUT_MS: '1500' }), 1500)
  assert.equal(timeoutOf({ MINBOX_SUBAGENT_TIMEOUT_MS: 'junk' }), 600_000)
  const roles = new Map([['scout', {} as any]])
  assert.match(validateParams({}, roles)!, /tasks is required/)
  assert.match(validateParams({ tasks: Array(9).fill({ task: 'x' }) }, roles)!, /At most 8/)
  assert.match(validateParams({ tasks: [{ task: ' ' }] }, roles)!, /tasks\[0\]\.task/)
  assert.match(validateParams({ tasks: [{ task: 'x', role: 'nope' }] }, roles)!, /Available: scout/)
  assert.match(validateParams({ tasks: [{ task: 'x', thinking: 'wild' }] }, roles)!, /thinking/)
  assert.match(validateParams({ tasks: [{ task: 'x', write: 'yes' }] }, roles)!, /boolean/)
  assert.equal(validateParams({ tasks: [{ task: 'x', role: 'scout', write: true }], max_concurrency: 2 }, roles), null)
})

// ---- worktrees ----

test('worktree: created on a new branch at HEAD, committed when changed, removed when not; refused outside a repository', async () => {
  const git = realGit()
  const r = repo()
  const root = tmp('sub-wt-')
  const base = sh(r, 'rev-parse', 'HEAD').trim()

  const w1 = await createWorktree(git, { cwd: join(r, 'sub'), root, id: 'abc-1' })
  assert.equal(w1.branch, 'minbox-sub/abc-1')
  assert.equal(w1.base, base)
  assert.equal(w1.childCwd, join(w1.path, 'sub'))
  assert.ok(existsSync(join(w1.path, 'a.txt')))
  assert.equal(sh(r, 'status', '--porcelain'), '', 'the main checkout is untouched')
  writeFileSync(join(w1.childCwd, 'new.txt'), 'n\n')
  writeFileSync(join(w1.path, 'a.txt'), 'two\n')
  const i1 = await finishWorktree(git, w1, 'msg')
  assert.equal(i1.removed, false)
  assert.match(i1.diffstat!, /new\.txt/)
  assert.match(i1.diffstat!, /a\.txt/)
  assert.equal(sh(w1.path, 'status', '--porcelain'), '')
  assert.equal(sh(r, 'rev-parse', w1.branch).trim(), i1.commit)
  assert.equal(readFileSync(join(r, 'a.txt'), 'utf8'), 'one\n')
  assert.equal(sh(r, 'rev-parse', 'HEAD').trim(), base, 'HEAD of the main checkout did not move')

  const w2 = await createWorktree(git, { cwd: r, root, id: 'abc-2' })
  const i2 = await finishWorktree(git, w2, 'msg')
  assert.equal(i2.removed, true)
  assert.equal(existsSync(w2.path), false)
  assert.equal(sh(r, 'branch', '--list', 'minbox-sub/abc-2').trim(), '')
  assert.match(sh(r, 'branch', '--list', 'minbox-sub/*'), /abc-1/)

  // A child that committed on its own is also a change.
  const w3 = await createWorktree(git, { cwd: r, root, id: 'abc-3' })
  writeFileSync(join(w3.path, 'c.txt'), 'c\n')
  sh(w3.path, 'add', '-A')
  sh(w3.path, '-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-q', '-m', 'own')
  const i3 = await finishWorktree(git, w3, 'msg')
  assert.equal(i3.removed, false)
  assert.match(i3.diffstat!, /c\.txt/)

  await assert.rejects(createWorktree(git, { cwd: tmp('sub-nogit-'), root, id: 'x' }), /needs a git repository/)
  const empty = tmp('sub-empty-')
  sh(empty, 'init', '-q')
  await assert.rejects(createWorktree(git, { cwd: empty, root, id: 'y' }), /at least one commit/)
})

// ---- whole tool calls ----

test('a read-only task: child argv, scrubbed environment, usage, role prompt', async () => {
  const t = setup({ env: { MINBOX_TOKEN: 'secret', MINBOX_SERVER_FILE: '/x', PI_SESSION_ID: 'p' } })
  const env = await t.call({ tasks: [{ task: 'ENVKEYS' }] })
  assert.match(env.content[0].text, /^ok\nnone/)
  const r = await t.call({ tasks: [{ task: 'ARGS', role: 'scout', thinking: 'low' }] })
  const text: string = r.content[0].text
  assert.match(text, /"--tools","read,grep,find,ls"/)
  assert.match(text, /"-ne"/)
  assert.match(text, /"-nc"/)
  assert.match(text, /"--offline"/)
  assert.match(text, /"--model","fake\/m"/)
  assert.match(text, /"--thinking","low"/)
  assert.match(text, /"--append-system-prompt","[^"]*prompt-scout\.md"/)
  assert.deepEqual(r.details.usage, { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.01, turns: 1 })
  assert.equal(r.details.results[0].status, 'ok')
  assert.equal(r.details.results[0].worktree, undefined)
})

test('write: true works in a worktree on a new branch and keeps it with branch, path and diffstat; the checkout is untouched', async () => {
  const t = setup()
  const r = repo()
  const res = await t.call({ tasks: [{ task: 'WRITE a file', write: true, role: 'worker' }] }, { cwd: r })
  const w = res.details.results[0].worktree
  assert.equal(res.details.results[0].status, 'ok')
  assert.equal(w.removed, false)
  assert.match(w.branch, /^minbox-sub\//)
  assert.match(w.diffstat, /written\.txt/)
  assert.match(res.content[0].text, new RegExp(`branch: ${w.branch}`))
  assert.match(res.content[0].text, /git merge/)
  assert.ok(w.path.startsWith(t.deps.worktreeRoot))
  assert.equal(sh(r, 'show', `${w.branch}:written.txt`), 'hello\n')
  assert.equal(existsSync(join(r, 'written.txt')), false)
  assert.equal(sh(r, 'status', '--porcelain'), '')
  assert.equal(sh(r, 'branch', '--show-current').trim(), 'main')
  assert.match(res.details.results[0].tools.join(','), /edit,write,bash/)
})

test('write: true with no change removes the worktree and branch; outside a repository it is refused', async () => {
  const t = setup()
  const r = repo()
  const res = await t.call({ tasks: [{ task: 'just look', write: true }] }, { cwd: r })
  assert.equal(res.details.results[0].worktree.removed, true)
  assert.equal(existsSync(res.details.results[0].worktree.path), false)
  assert.equal(sh(r, 'branch', '--list', 'minbox-sub/*').trim(), '')
  assert.match(res.content[0].text, /no changes/)

  const nogit = await t.call({ tasks: [{ task: 'WRITE x', write: true }] }, { cwd: tmp('sub-nogit-') })
  assert.equal(nogit.details.results[0].status, 'error')
  assert.match(nogit.content[0].text, /needs a git repository/)
  // The read-only sibling in the same call still runs.
  const mixed = await t.call({ tasks: [{ task: 'WRITE x', write: true }, { task: 'plain' }] }, { cwd: tmp('sub-nogit-') })
  assert.deepEqual(mixed.details.results.map((x: any) => x.status), ['error', 'ok'])
})

test('without write: true even a task asking for bash gets none, so nothing is written', async () => {
  const t = setup()
  const res = await t.call({ tasks: [{ task: 'ARGS', tools: ['bash', 'write', 'read'] }] })
  assert.match(res.content[0].text, /"--tools","read"/)
  assert.match(res.content[0].text, /read-only/)
})

test('a failing child is an error with its message; big output is cut', async () => {
  const t = setup()
  const res = await t.call({ tasks: [{ task: 'FAIL' }, { task: 'BIG' }] })
  assert.deepEqual(res.details.results.map((x: any) => x.status), ['error', 'ok'])
  assert.match(res.details.results[0].output, /model said no/)
  assert.equal(res.details.results[1].truncated, true)
  assert.ok(Buffer.byteLength(res.details.results[1].output) < 41 * 1024)
})

test('parallel: 8 tasks run at most 4 at a time; max_concurrency lowers it', async () => {
  const overlap = (log: string) => {
    let cur = 0
    let max = 0
    for (const l of readFileSync(log, 'utf8').trim().split('\n')) {
      cur += l.startsWith('start') ? 1 : -1
      max = Math.max(max, cur)
    }
    return max
  }
  const t = setup()
  const res = await t.call({ tasks: Array.from({ length: 8 }, (_, i) => ({ task: `SLOW ${i}` })) })
  assert.equal(res.details.results.filter((x: any) => x.status === 'ok').length, 8)
  assert.equal(overlap(t.log), 4)
  assert.match(res.content[0].text, /8\/8 tasks ok/)
  const t2 = setup()
  await t2.call({ tasks: Array.from({ length: 4 }, (_, i) => ({ task: `SLOW ${i}` })), max_concurrency: 2 })
  assert.equal(overlap(t2.log), 2)
  await assert.rejects(t.call({ tasks: Array(9).fill({ task: 'x' }) }), /At most 8/)
})

test('abort stops the children (SIGTERM, then SIGKILL) and an empty worktree goes away', async () => {
  const t = setup({ killGraceMs: 150 })
  const r = repo()
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 300)
  const t0 = Date.now()
  const res = await t.call({ tasks: [{ task: 'HANG', write: true }, { task: 'HANG STUBBORN' }] }, { signal: ac.signal, cwd: r })
  assert.ok(Date.now() - t0 < 5000)
  assert.deepEqual(res.details.results.map((x: any) => x.status), ['aborted', 'aborted'])
  assert.equal(res.details.results[0].worktree.removed, true)
  assert.equal(sh(r, 'branch', '--list', 'minbox-sub/*').trim(), '')
})

test('a child over MINBOX_SUBAGENT_TIMEOUT_MS is stopped and reported as timeout', async () => {
  const t = setup({ env: { MINBOX_SUBAGENT_TIMEOUT_MS: '300' }, killGraceMs: 100 })
  const res = await t.call({ tasks: [{ task: 'HANG' }, { task: 'quick' }] })
  assert.deepEqual(res.details.results.map((x: any) => x.status), ['timeout', 'ok'])
  assert.match(res.details.results[0].output, /timed out after/)
})

test('killAll (Pi shutting down) kills running children', async () => {
  const t = setup({ killGraceMs: 100 })
  const p = t.call({ tasks: [{ task: 'HANG STUBBORN' }] })
  await new Promise((r) => setTimeout(r, 300))
  await t.handlers.get('session_shutdown')!()
  const res = await p
  assert.equal(res.details.results[0].status, 'error')
})

test('a run keeps the busy marker and the partial results coming', async () => {
  const t = setup({ heartbeatMs: 50 })
  const seq0 = busySeq()
  const updates: any[] = []
  await t.call({ tasks: [{ task: 'SLOW a' }, { task: 'SLOW b' }] }, { onUpdate: (u) => updates.push(u) })
  assert.ok(updates.length >= 3)
  assert.ok(busySeq() - seq0 >= 5)
  assert.match(updates[0].content[0].text, /subagents: 0\/2 done/)
  assert.match(updates.at(-1).content[0].text, /2\/2 done, 0 running/)
})

test('bad parameters throw a clear error; an unknown role lists the available ones', async () => {
  const t = setup()
  await assert.rejects(t.call({ tasks: [{ task: 'x', role: 'ghost' }] }), /Available: .*scout/)
  await assert.rejects(t.call({ tasks: [{ task: 'x', cwd: '/definitely/not/here' }] }).then((r: any) => {
    throw new Error(r.details.results[0].output)
  }), /cwd does not exist/)
})

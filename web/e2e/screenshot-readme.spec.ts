import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, expectTerminal, test, trustBrowser, typeInTerminal, type Minbox } from './fixtures'
import { api, startAgent, type Agent } from './v3'

// Not a check: the README's screenshots (docs/img/readme/), from a made-up scene. Regenerate with
//   make build && cd web && SCREENSHOTS=1 npx playwright test e2e/screenshot-readme.spec.ts
// Everything in them is invented: three projects, four agents, their tasks and messages, and a canned
// terminal transcript. The fake claude does not answer by itself here (FAKE_AGENT=0): the scene's agent
// messages and tasks are written through the agent API with each session's own token.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SUGGESTIONS = join(process.env.TMPDIR ?? '/tmp', `minbox-readme-suggest-${process.pid}.json`)
if (process.env.SCREENSHOTS === '1') {
  process.env.FAKE_SUGGEST_FILE = SUGGESTIONS
  process.env.FAKE_AGENT = '0'
}

const OUT = process.env.SCREENSHOT_DIR ?? resolve(__dirname, '../../docs/img/readme')
const MIN = 60_000

const dbOf = (m: Minbox) => {
  const db = readdirSync(m.dataDir).find((f) => f.endsWith('.db'))
  if (!db) throw new Error('no database in ' + m.dataDir)
  return join(m.dataDir, db)
}
const sql = (m: Minbox, q: string) => execFileSync('sqlite3', [dbOf(m)], { input: '.timeout 5000\n' + q + '\n' }).toString().trim()

/** The agent API, as the agent's mod calls it (its session's token). */
async function as(m: Minbox, a: Agent, method: string, path: string, body?: unknown): Promise<any> {
  const token = sql(m, `SELECT token FROM sessions WHERE id='${a.id}';`)
  const r = await fetch(m.url + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

type Step = [string, boolean]
const steps = (s: Step[]) => s.map(([text, done]) => ({ text, done }))

const AUDIT_Q = `I looked at how \`api-gateway\` would write its audit log; the choice is between two stores.

- Roughly **1.2k writes a minute**, about 400 bytes each, almost no updates.
- Reads are rare: an admin searches by actor or by day.
- Postgres already runs for billing, but not in every environment.

The schema I would start with is attached.

:::question
Which database should hold the audit log?

SQLite needs nothing new to run. Postgres is easier to query across several gateways.

- [ ] SQLite — one file per gateway, no new service
- [ ] Postgres — shared, but a new dependency per environment
- [ ] Keep the log files — no database yet

Recommended: SQLite
:::`

const D = '\x1b[2m'
const R = '\x1b[0m'
const B = '\x1b[1m'
const G = '\x1b[32m'
/** The terminal pane: a canned Claude Code-like transcript (typed into the fake as `transcript <file>`). */
const TRANSCRIPT = (width: number, pad: number) =>
  [
    `${B}> Add an audit trail for admin actions: who did what, when.${R}`,
    '',
    `${G}●${R} ${B}minbox - create_task${R}(title: "Store the audit log…")`,
    `  ${D}⎿  Task created${R}`,
    '',
    `${G}●${R} ${B}Search${R}(pattern: "requireAdmin", path: "internal")`,
    `  ${D}⎿  Found 14 files${R}`,
    '',
    `${G}●${R} ${B}Update${R}(internal/audit/writer.go)`,
    `  ${D}⎿  Updated with 23 additions and 4 removals${R}`,
    '',
    `${G}●${R} ${B}Bash${R}(go test ./internal/audit/...)`,
    `  ${D}⎿  ok  api-gateway/internal/audit  0.412s${R}`,
    '',
    `${G}●${R} ${B}minbox - update_task${R}(check_steps: [1, 2])`,
    `  ${D}⎿  Steps 1, 2 done${R}`,
    '',
    `${G}●${R} ${B}Write${R}(audit-schema.sql)`,
    `  ${D}⎿  Wrote 8 lines${R}`,
    '',
    `${G}●${R} ${B}minbox - send_message${R}(question: "Which database…")`,
    `  ${D}⎿  Sent; the person answers in minbox${R}`,
    '',
    `${G}●${R} The question is in minbox. I will carry on`,
    '  when you answer.',
    ...Array(pad).fill(''),
    `${D}╭${'─'.repeat(width)}╮${R}`,
    `${D}│${R} >${' '.repeat(width - 2)}${D}│${R}`,
    `${D}╰${'─'.repeat(width)}╯${R}`,
    `${D}  ? for shortcuts${R}`,
  ].join('\n')

test.use({ deviceScaleFactor: 1.5 })

test('README screenshots', async ({ page, minbox, browser }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(SUGGESTIONS, JSON.stringify([{ question: 'Which database for the audit log?', kind: 'single', options: [{ label: 'SQLite for now' }, { label: 'Postgres', description: 'billing already runs it' }] }, { question: 'Anything to plan for?', kind: 'multi', options: [{ label: 'Retention' }, { label: 'Backups' }] }]))
  const shot = async (name: string, p: Page = page) => {
    await p.waitForTimeout(700)
    await p.screenshot({ path: `${OUT}/${name}.png` })
  }

  // Agents (fake claude sessions) in three projects.
  const audit = await startAgent(minbox, 'audit-log', 'work/api-gateway')
  const limits = await startAgent(minbox, 'limits', 'work/api-gateway')
  const docs = await startAgent(minbox, 'docs', 'work/docs-site')
  const checkout = await startAgent(minbox, 'checkout', 'work/mobile-app')
  writeFileSync(join(minbox.dataDir, 'work/api-gateway/audit-schema.sql'), 'CREATE TABLE audit_events (\n  id     INTEGER PRIMARY KEY,\n  at     TIMESTAMP NOT NULL,\n  actor  TEXT NOT NULL,\n  action TEXT NOT NULL,\n  target TEXT\n);\nCREATE INDEX audit_events_at ON audit_events (at);\n')
  writeFileSync(join(minbox.dataDir, 'work/docs-site/migrate-v2.md'), '# Migrating to v2\n\nThree options were renamed and two flags were removed.\n\n## Renamed options\n\n| v1 | v2 |\n| --- | --- |\n| `base_url` | `site.url` |\n| `theme` | `site.theme` |\n')

  const ages: [string, number][] = [] // message id, minutes ago
  const span: Record<string, [number, number]> = {} // task id -> its first and last message (minutes ago)
  const aged = (task: string, ago: number) => {
    const [first, last] = span[task] ?? [ago, ago]
    span[task] = [Math.max(first, ago), Math.min(last, ago)]
  }
  const person = async (a: Agent, words: string, task: string, ago: number) => {
    const r = await api(minbox, 'POST', `/api/v3/sessions/${a.id}/messages`, { words, task_id: task })
    ages.push([r.id ?? r.message?.id, ago])
    aged(task, ago)
  }
  const agent = async (a: Agent, body: string, task: string, ago: number, extra: Record<string, unknown> = {}) => {
    // Each message keeps its task's status as created (send_message's task_status).
    const r = await as(minbox, a, 'POST', '/api/agent/messages', { body, task_id: task, task_status: statusOf[task] ?? 'working', ...extra })
    ages.push([r.message_id ?? r.id, ago])
    aged(task, ago)
    return r
  }
  const statusOf: Record<string, string> = {} // task id -> the status it was created with
  const task = async (a: Agent, fields: Record<string, unknown>) => {
    const id = (await as(minbox, a, 'POST', '/api/agent/tasks', fields)).task_id as string
    statusOf[id] = (fields.status as string) ?? 'working'
    return id
  }

  // api-gateway / audit-log
  const tAudit = await task(audit, { title: 'Store the audit log for admin actions', summary: 'Writer and tests done; waiting on the database choice before the migration', steps: steps([['Find every admin action that changes state', true], ['Write events through one interface', true], ['Pick the store', false], ['Migration and retention job', false], ['Open the PR', false]]) })
  await person(audit, 'Add an audit trail for admin actions: who did what, when. Keep it cheap to run.', tAudit, 52)
  await agent(audit, 'On it. I found **14 admin handlers** that change state; each now calls `audit.Record(ctx, action, target)`. `go test ./internal/audit/...` passes.', tAudit, 31)
  await agent(audit, AUDIT_Q, tAudit, 3, { attachments: ['audit-schema.sql'] })
  const tAuditDone = await task(audit, { title: 'Explain the admin role checks', status: 'done', summary: 'Answered: roles come from the session, checked in one middleware' })
  await person(audit, 'Where are admin roles checked today?', tAuditDone, 70)
  await agent(audit, 'In one place: `internal/http/admin.go` reads the role from the session and rejects everything else with 403.', tAuditDone, 69)

  // api-gateway / rate-limits
  const tRetry = await task(limits, { title: 'Add a Retry-After header to 429 responses', status: 'done', summary: 'Merged: every 429 carries Retry-After', steps: steps([['Return the refill time with the decision', true], ['Set the header in the middleware', true], ['Tests for the burst case', true]]) })
  await person(limits, 'Make 429s tell clients when to retry.', tRetry, 180)
  await agent(limits, 'Done. Every 429 now carries `Retry-After` (seconds until the bucket refills); 14 limiter tests pass.', tRetry, 150)
  const tRoutes = await task(limits, { title: 'Per-route rate limits', summary: 'Config parsed; wiring the limiter per route', steps: steps([['Config format for per-route limits', true], ['Parse and validate it', true], ['One bucket per route and key', false], ['Docs', false]]) })
  await person(limits, 'Next: let routes set their own limits in the config.', tRoutes, 40)
  await agent(limits, 'Config parsing is in; `routes[].limit` accepts `100/min` or `5/s`. Wiring the limiter now.', tRoutes, 8)

  // docs-site / docs
  const tGuide = await task(docs, { title: 'Draft the v2 migration guide', status: 'needs_you', summary: 'Draft ready for review; three TODOs need your call', steps: steps([['List renamed options and removed flags', true], ['Before/after config example', true], ['Review', false]]) })
  await person(docs, 'Write a migration guide for v2.', tGuide, 120)
  await agent(docs, 'The draft is in `migrate-v2.md`: renamed options, removed flags and a before/after config. I left three `TODO` markers where I could not verify behavior.', tGuide, 38, { attachments: ['migrate-v2.md'] })
  const tLinks = await task(docs, { title: 'Fix broken links in the API reference', summary: '212 pages crawled, 9 broken links; fixing the redirects', steps: steps([['Crawl the built site', true], ['Fix redirects', false], ['Re-crawl', false]]) })
  await person(docs, 'Some links in the API reference 404. Can you find and fix them?', tLinks, 25)
  await agent(docs, 'Crawled the built site: 212 pages, **9 broken links**, all from the `/v1/` → `/reference/` move. Fixing the redirects first.', tLinks, 2)

  // mobile-app / checkout
  const tFlaky = await task(checkout, { title: 'Fix the flaky checkout_spec', summary: 'Found the race: the total is read before the price update lands', steps: steps([['Reproduce (fails 1 run in 6)', true], ['Find the race', true], ['Wait on the price update', false], ['Run the spec 50 times', false]]) })
  await person(checkout, 'checkout_spec fails on CI now and then. Please fix it.', tFlaky, 30)
  await agent(checkout, 'It fails about one run in six: the cart total is read before the price update lands. Adding a wait on the update, then 50 runs.', tFlaky, 4)

  // A goal the flaky-test task serves (no autonomous run: the fake does not answer continuations here).
  const tGoal = await task(checkout, { title: 'CI green on main', kind: 'goal', criteria: [{ text: 'checkout_spec passes 50 runs in a row', done: false }, { text: 'No skipped tests in the e2e suite', done: true }, { text: 'main stays green for a day', done: false }] })
  await as(minbox, checkout, 'PATCH', `/api/agent/tasks/${tFlaky}`, { goal_id: tGoal })
  span[tGoal] = [90, 4]

  // Believable ages (the server stamps everything "now"), and a made-up home folder.
  const now = Date.now()
  const at = (mins: number) => now - mins * MIN
  const real = join(minbox.dataDir, 'work')
  sql(
    minbox,
    [
      ...ages.map(([id, mins]) => `UPDATE messages SET created_at=${at(mins)} WHERE id='${id}'; UPDATE message_tasks SET created_at=${at(mins)} WHERE message_id='${id}';`),
      ...Object.entries(span).map(([id, [first, last]]) => `UPDATE tasks SET created_at=${at(first)}, updated_at=${at(last)}, done_at=CASE WHEN done_at IS NULL THEN NULL ELSE ${at(last)} END WHERE id='${id}'; UPDATE task_events SET at=${at(first)} WHERE task_id='${id}';`),
      `UPDATE sessions SET cwd = replace(cwd, '${real}', '/home/dev'); UPDATE projects SET dir = replace(dir, '${real}', '/home/dev');`,
    ].join('\n'),
  )
  await as(minbox, checkout, 'POST', '/api/agent/status', { status: 'working' })
  await as(minbox, docs, 'POST', '/api/agent/status', { status: 'working' })

  // Desktop, dark: the agent's page with the task selected (its card and checklist above its messages).
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${minbox.url}/#s=${audit.id}&v=agent&k=${tAudit}`)
  await expect(page.getByTestId('task-card')).toBeVisible()
  await expect(page.getByTestId('question-card').first()).toBeVisible()
  await shot('hero-desktop')

  // The Board.
  await page.setViewportSize({ width: 1600, height: 680 })
  await page.goto(`${minbox.url}/#`)
  await expect(page.getByTestId('group-goals')).toBeVisible()
  await shot('board')

  // A side pane: the stream with the agent's terminal beside it.
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`${minbox.url}/#s=${audit.id}&v=agent`)
  await expect(page.getByTestId('stream-view')).toBeVisible()
  const tfile = join(minbox.dataDir, 'transcript.txt')
  writeFileSync(tfile, TRANSCRIPT(52, 18))
  await typeInTerminal(page, `transcript ${tfile}`)
  await expectTerminal(page, 'when you answer')
  await shot('terminal')

  // Phone, dark: the Board, a task in its agent's page, another; composed into one image.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true })
  await trustBrowser(ctx)
  const ph = await ctx.newPage()
  await ph.goto(minbox.url + '/#')
  await expect(ph.getByTestId('phone-tabs')).toBeVisible()
  await expect(ph.getByTestId('task-row').first()).toBeVisible()
  await shot('_phone-1', ph)
  writeFileSync(SUGGESTIONS, JSON.stringify([{ question: 'Routes without a limit of their own?', kind: 'single', options: [{ label: 'Use the global limit' }, { label: 'No limit' }] }]))
  await ph.goto(`${minbox.url}/#s=${limits.id}&v=agent&k=${tRoutes}`)
  await expect(ph.getByTestId('task-card')).toBeVisible()
  const toggle = ph.getByTestId('task-checklist').getByTestId('task-checklist-toggle')
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.tap()
  await expect(ph.getByTestId('task-checklist').getByTestId('step').first()).toBeVisible()
  await expect(ph.getByTestId('reply-q')).toHaveCount(1)
  await shot('_phone-2', ph)
  // A task waiting on the person, with the agent's attachment.
  writeFileSync(SUGGESTIONS, JSON.stringify([{ question: 'The three TODOs?', kind: 'single', options: [{ label: 'Keep them for now' }, { label: 'Resolve them before publishing' }] }, { question: 'Also cover?', kind: 'multi', options: [{ label: 'Plugins' }, { label: 'Themes' }] }]))
  await ph.goto(`${minbox.url}/#s=${docs.id}&v=agent&k=${tGuide}`)
  await expect(ph.getByTestId('task-card')).toBeVisible()
  await expect(ph.getByTestId('reply-q')).toHaveCount(2)
  await shot('_phone-3', ph)
  await ctx.close()
  const urls = ['_phone-1', '_phone-2', '_phone-3'].map((n) => 'data:image/png;base64,' + readFileSync(`${OUT}/${n}.png`).toString('base64'))
  const comp = await browser.newPage({ viewport: { width: 1320, height: 940 }, deviceScaleFactor: 1.5 })
  await comp.setContent(`<body style="margin:0;background:#e9e7e3;display:flex;gap:28px;justify-content:center;align-items:center;height:100vh">
    ${urls.map((u) => `<img src="${u}" width="390" height="844" style="border-radius:28px;box-shadow:0 12px 40px rgba(0,0,0,.28);border:1px solid rgba(0,0,0,.2)">`).join('')}</body>`)
  await comp.waitForTimeout(500)
  await comp.screenshot({ path: `${OUT}/phone-trio.png` })
  await comp.close()
  for (const n of ['_phone-1', '_phone-2', '_phone-3']) rmSync(`${OUT}/${n}.png`)

  // Settings -> Notifications with two Slack destinations (made-up webhooks).
  await page.goto(minbox.url + '/#v=settings&ss=notifications')
  await expect(page.getByTestId('notif-list')).toBeVisible()
  await page.getByTestId('notif-public-url').fill('https://devbox.example-tailnet.ts.net/')
  await page.getByTestId('notif-public-url-save').click()
  await page.getByTestId('notif-add').click()
  await page.getByTestId('notif-form-name').fill('#eng-agents')
  await page.getByTestId('notif-field-webhook_url').fill(fakeWebhook('B04EF5GH6', 'x'))
  await page.getByTestId('notif-save').click()
  await expect(page.getByTestId('notif-row')).toHaveCount(1)
  await page.getByTestId('notif-add').click()
  await page.getByTestId('notif-form-name').fill('#api-gateway (questions only)')
  await page.getByTestId('notif-field-webhook_url').fill(fakeWebhook('B07IJ8KL9', 'y'))
  await page.getByTestId('notif-field-events').selectOption('action')
  await page.getByTestId('notif-save').click()
  await expect(page.getByTestId('notif-row')).toHaveCount(2)
  await expect(page.getByText('Saved', { exact: true })).toHaveCount(0)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/notifications.png`, clip: { x: 0, y: 0, width: 1240, height: 600 } })
})

/** A made-up incoming-webhook URL, assembled at run time: secret scanners flag the literal form. */
function fakeWebhook(channel: string, fill: string): string {
  return ['https:/', ['hooks', 'slack', 'com'].join('.'), 'services', 'T01AB2CD3', channel, fill.repeat(24)].join('/')
}

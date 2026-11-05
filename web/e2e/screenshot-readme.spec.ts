import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSession, expect, expectTerminal, selectProject, test, typeInTerminal } from './fixtures'

// Not a check: the README's screenshots (docs/img/readme/), from a made-up scene. Regenerate with
//   cd web && SCREENSHOTS=1 npx playwright test e2e/screenshot-readme.spec.ts
// Everything in them is invented: three projects, a few threads and a canned terminal transcript.

const __dirname = dirname(fileURLToPath(import.meta.url))
const SUGGESTIONS = join(process.env.TMPDIR ?? '/tmp', `minbox-readme-suggest-${process.pid}.json`)
if (process.env.SCREENSHOTS === '1') process.env.FAKE_SUGGEST_FILE = SUGGESTIONS

const OUT = process.env.SCREENSHOT_DIR ?? resolve(__dirname, '../../docs/img/readme')
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const MIN = 60_000
const PALETTE_QUERY = 'audit'

type Msg = { subject: string; body: string; status?: string; attachments?: string[]; ago: number }

const AUDIT_BODY = `I looked at how \`api-gateway\` would write its audit log, and the choice is between two stores.

## What I found

- Roughly **1.2k writes per minute**, about 400 bytes each, and almost no updates.
- Reads are rare: an admin searches by actor or by day.
- A Postgres runs for billing, but not in every environment.

## The table

\`\`\`sql
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  at TIMESTAMP NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL
);
\`\`\`

:::question
Which database should hold the audit log?

SQLite needs nothing new to run. Postgres is easier to query across several gateways.

- [ ] SQLite — one file, no new service
- [ ] Postgres — shared, but a new dependency per environment
- [ ] Keep the log files — no database yet

Recommended: SQLite
:::`

const MESSAGES: Record<string, Msg[]> = {
  'api-gateway/main': [
    {
      subject: 'Add a Retry-After header to 429 responses',
      body: 'Done. Every 429 now carries `Retry-After` (seconds until the bucket refills), and the limiter tests cover it.\n\n## What changed\n\n- `internal/limit/limiter.go`: the refill time is returned with the decision\n- `internal/http/middleware.go`: the header is set once, in one place\n- 14 tests pass, including the burst case\n\n```go\nif !d.Allowed {\n\tw.Header().Set(\"Retry-After\", s)\n\tw.WriteHeader(429)\n\treturn\n}\n```\n\nI did not touch the per-route limits.',
      status: 'finished',
      ago: 6,
    },
    {
      subject: 'Rate limiter: token bucket or sliding window?',
      body: 'I kept the token bucket. It is already what the config describes, and it needs one counter per key instead of a list of timestamps.\n\nIf you want a hard per-minute cap later, the sliding window fits behind the same interface.',
      status: 'finished',
      ago: 140,
    },
  ],
  'api-gateway/audit-log': [
    { subject: 'Pick a database for the audit log', body: AUDIT_BODY, status: 'need_action', attachments: ['audit-schema.sql'], ago: 2 },
  ],
  'docs-site/main': [
    {
      subject: 'Draft the v2 migration guide',
      body: 'The draft is in `docs/migrate-v2.md`: renamed options, removed flags and a before/after config example. I left three `TODO` markers where I could not verify behavior.',
      status: 'finished',
      attachments: ['migrate-v2.md'],
      ago: 38,
    },
    { subject: 'Broken links in the API reference', body: 'Crawling the built site: 212 pages checked, 9 broken links so far. Fixing the redirects first.', status: 'working', ago: 1 },
  ],
  'mobile-app/main': [
    { subject: 'Flaky test in checkout_spec', body: 'It fails about one run in six. The cart total is read before the price update lands. I am adding a wait on the update and running the spec 50 times.', status: 'working', ago: 4 },
    { subject: 'Bump React Native to 0.76', body: 'Upgraded and both apps build. The only code change was a renamed `Platform` import.', status: 'finished', ago: 1560 },
  ],
  'mobile-app/permissions': [
    {
      subject: 'Wording for the notification permission prompt',
      body: 'The iOS prompt shows once, so the pre-prompt screen matters.\n\n:::question\nWhich headline should the pre-prompt use?\n- [ ] "Stay on top of your orders"\n- [ ] "Get delivery updates"\nRecommended: "Get delivery updates"\n:::',
      status: 'need_action',
      ago: 17,
    },
  ],
}

const D = '\x1b[2m'
const R = '\x1b[0m'
const B = '\x1b[1m'
const G = '\x1b[32m'
const PAD = 18
const PHONE_PAD = 8
const EARLIER = [
  `${B}> Add an audit trail for admin actions in api-gateway${R}`,
  '',
  `${G}\u25cf${R} ${B}Update${R}(internal/audit/writer.go)`,
  `  ${D}\u23bf  Updated with 23 additions and 4 removals${R}`,
  '',
  `${G}\u25cf${R} ${B}Bash${R}(go test ./internal/audit/...)`,
  `  ${D}\u23bf  ok  api-gateway/internal/audit  0.412s${R}`,
  '',
  `${G}\u25cf${R} Events are written through a small interface now.`,
  '  Next I need to decide where they are stored.',
  '',
  '',
]
const TRANSCRIPT = [
  ...EARLIER,
  `${B}> Compare SQLite and Postgres for the audit log${R}`,
  '',
  `${G}●${R} I’ll look at how the gateway writes events today`,
  '  and what the deployment already runs.',
  '',
  `${G}●${R} ${B}Search${R}(pattern: "audit", path: "internal")`,
  `  ${D}⎿  Found 11 files${R}`,
  '',
  `${G}●${R} ${B}Read${R}(internal/audit/writer.go)`,
  `  ${D}⎿  Read 148 lines${R}`,
  '',
  `${G}●${R} ${B}Read${R}(deploy/compose.yaml)`,
  `  ${D}⎿  Read 62 lines${R}`,
  '',
  `${G}●${R} ${B}Write${R}(audit-schema.sql)`,
  `  ${D}⎿  Wrote 7 lines${R}`,
  '',
  `${G}●${R} ${B}minbox - send_message${R}(subject: "Pick a datab…")`,
  `  ${D}⎿  Sent to the inbox${R}`,
  '',
  `${G}●${R} The question is in your inbox. I will carry on`,
  '  when you answer.',
  ...Array(PAD).fill(''),
  `${D}╭${'─'.repeat(52)}╮${R}`,
  `${D}│${R} >${' '.repeat(50)}${D}│${R}`,
  `${D}╰${'─'.repeat(52)}╯${R}`,
  `${D}  ? for shortcuts${R}`,
].join('\n')

const PHONE_TRANSCRIPT = [
  `${B}> Compare SQLite and Postgres${R}`,
  '',
  `${G}\u25cf${R} I\u2019ll check how the gateway`,
  '  writes events today.',
  '',
  `${G}\u25cf${R} ${B}Search${R}("audit", internal)`,
  `  ${D}\u23bf  Found 11 files${R}`,
  '',
  `${G}\u25cf${R} ${B}Read${R}(audit/writer.go)`,
  `  ${D}\u23bf  Read 148 lines${R}`,
  '',
  `${G}\u25cf${R} ${B}Read${R}(deploy/compose.yaml)`,
  `  ${D}\u23bf  Read 62 lines${R}`,
  '',
  `${G}\u25cf${R} ${B}Write${R}(audit-schema.sql)`,
  `  ${D}\u23bf  Wrote 7 lines${R}`,
  '',
  `${G}\u25cf${R} ${B}minbox - send_message${R}`,
  `  ${D}\u23bf  Sent to the inbox${R}`,
  '',
  `${G}\u25cf${R} The question is in your inbox.`,
  '  I will carry on when you answer.',
  '',
  ...Array(PHONE_PAD).fill(''),
  `${D}\u256d${'\u2500'.repeat(36)}\u256e${R}`,
  `${D}\u2502${R} >${' '.repeat(34)}${D}\u2502${R}`,
  `${D}\u2570${'\u2500'.repeat(36)}\u256f${R}`,
  `${D}  ? for shortcuts${R}`,
].join('\n')

async function poll(fn: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('timed out: ' + what)
}

test.use({ deviceScaleFactor: 1.5 })

/** A made-up incoming-webhook URL, assembled at run time: secret scanners flag the literal form. */
function fakeWebhook(channel: string, fill: string): string {
  return ['https:/', ['hooks', 'slack', 'com'].join('.'), 'services', 'T01AB2CD3', channel, fill.repeat(24)].join('/')
}

test('README screenshots', async ({ page, minbox, browser }) => {
  test.skip(process.env.SCREENSHOTS !== '1', 'set SCREENSHOTS=1')
  test.setTimeout(300_000)
  mkdirSync(OUT, { recursive: true })
  writeFileSync(SUGGESTIONS, JSON.stringify(['Go with SQLite for now', 'Postgres: we already run it', 'How would we migrate later?']))
  const specDir = join(minbox.dataDir, 'spec')
  mkdirSync(specDir, { recursive: true })
  const dirOf = (p: string) => {
    const d = join(minbox.dataDir, 'work', p)
    mkdirSync(d, { recursive: true })
    return d
  }
  const shot = async (name: string, p: Page = page) => {
    await p.waitForTimeout(700)
    await p.screenshot({ path: `${OUT}/${name}.png` })
  }
  const threadCount = async () => ((await (await fetch(minbox.url + '/api/threads')).json()) as any[]).length

  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(minbox.url)

  // Sessions and their threads.
  const sessions: [string, string][] = [
    ['api-gateway', 'main'],
    ['api-gateway', 'audit-log'],
    ['docs-site', 'main'],
    ['mobile-app', 'main'],
    ['mobile-app', 'permissions'],
  ]
  let n = 0
  const agos: Record<string, number> = {}
  for (const [proj, name] of sessions) {
    const dir = dirOf(proj)
    await createSession(page, dir, name)
    await expectTerminal(page, 'ready>')
    if (proj === 'api-gateway' && name === 'audit-log') {
      writeFileSync(join(dir, 'audit-schema.sql'), 'CREATE TABLE audit_events (\n  id     INTEGER PRIMARY KEY,\n  at     TIMESTAMP NOT NULL,\n  actor  TEXT NOT NULL,\n  action TEXT NOT NULL,\n  target TEXT\n);\nCREATE INDEX audit_events_at ON audit_events (at);\n')
    }
    if (proj === 'docs-site') writeFileSync(join(dir, 'migrate-v2.md'), '# Migrating to v2\n\nThree options were renamed and two flags were removed.\n\n## Renamed options\n\n| v1 | v2 |\n| --- | --- |\n| `base_url` | `site.url` |\n| `theme` | `site.theme` |\n')
    for (const m of MESSAGES[`${proj}/${name}`] ?? []) {
      const file = join(specDir, `m${++n}.json`)
      writeFileSync(file, JSON.stringify({ subject: m.subject, body: m.body, status: m.status, attachments: m.attachments }))
      const before = await threadCount()
      await typeInTerminal(page, `send ${file}`)
      await poll(async () => (await threadCount()) > before, m.subject)
      agos[m.subject] = m.ago
    }
  }

  // Give the threads believable ages (the server stamps everything "now").
  const db = readdirSync(minbox.dataDir).find((f) => f.endsWith('.db'))
  if (!db) throw new Error('no database in ' + minbox.dataDir)
  const now = Date.now()
  const sql = Object.entries(agos)
    .map(([s, mins]) => {
      const at = now - mins * MIN
      const q = s.replace(/'/g, "''")
      return `UPDATE messages SET created_at=${at} WHERE thread_id IN (SELECT id FROM threads WHERE subject='${q}'); UPDATE threads SET created_at=${at}, updated_at=${at} WHERE subject='${q}';`
    })
    .join('\n')
  // Show the made-up home directory instead of the test's temp directory.
  const real = join(minbox.dataDir, 'work')
  const paths = `UPDATE sessions SET cwd = replace(cwd, '${real}', '/home/dev'); UPDATE projects SET dir = replace(dir, '${real}', '/home/dev');`
  execFileSync('sqlite3', [join(minbox.dataDir, db)], { input: '.timeout 5000\n' + sql + '\n' + paths })

  // The open session's terminal: a canned transcript instead of the fake's plain output.
  const tfile = join(specDir, 'transcript.txt')
  writeFileSync(tfile, TRANSCRIPT)
  await page.goto(minbox.url + '/#')
  await page.reload()
  await page.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(page.getByTestId('terminal-session-name')).toHaveText('audit-log')
  await typeInTerminal(page, `transcript ${tfile}`)
  await expectTerminal(page, 'The question is in your inbox')
  const rz = (await page.getByTestId('resizer').first().boundingBox())!
  await page.mouse.move(rz.x + rz.width / 2, 400)
  await page.mouse.down()
  await page.mouse.move(rz.x + rz.width / 2 + 90, 400, { steps: 6 })
  await page.mouse.up()
  const showCard = (p: Page) => p.getByTestId('question-card').first().evaluate((el) => el.scrollIntoView({ block: 'end' }))
  await showCard(page)
  await shot('hero-desktop')

  // The palette over the same layout.
  await page.keyboard.press(`${MOD}+k`)
  await expect(page.getByTestId('palette')).toBeVisible()
  await page.getByTestId('palette-input').fill(PALETTE_QUERY)
  await expect(page.getByTestId('palette-item').first()).toBeVisible()
  await shot('palette')
  await page.keyboard.press('Escape')

  // Tablet: the list beside a finished thread, with reply suggestions.
  writeFileSync(SUGGESTIONS, JSON.stringify(['Looks good, open a PR', 'Add a test for the 60 s cap', 'Does this also cover the websocket route?']))
  await page.setViewportSize({ width: 834, height: 1112 })
  await page.goto(minbox.url + '/#')
  await expect(page.getByTestId('tablet')).toBeVisible()
  await page.getByTestId('thread-row').filter({ hasText: 'Retry-After' }).click()
  await expect(page.getByTestId('reply-suggestion')).toHaveCount(3)
  await shot('tablet')

  // Phone: three screens, composed into one image.
  writeFileSync(SUGGESTIONS, JSON.stringify(['Go with SQLite for now', 'Postgres: we already run it', 'How would we migrate later?']))
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme: 'dark', hasTouch: true, isMobile: true })
  const ph = await ctx.newPage()
  await ph.goto(minbox.url + '/#')
  await expect(ph.getByTestId('phone-home')).toBeVisible()
  await expect(ph.getByTestId('thread-row').first()).toBeVisible()
  await shot('_phone-1', ph)
  await ph.getByTestId('thread-row').filter({ hasText: 'Pick a database' }).click()
  await expect(ph.getByTestId('phone')).toHaveAttribute('data-screen', 'thread')
  await expect(ph.getByTestId('question-card').first()).toBeVisible()
  await showCard(ph)
  await shot('_phone-2', ph)
  await ph.getByTestId('phone-session-chip').click()
  await expect(ph.getByTestId('phone')).toHaveAttribute('data-screen', 'terminal')
  const tfile2 = join(specDir, 'transcript-phone.txt')
  writeFileSync(tfile2, PHONE_TRANSCRIPT)
  await typeInTerminal(ph, `transcript ${tfile2}`)
  await expectTerminal(ph, 'when you answer')
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

  // Settings -> Notifications with a Slack destination (a made-up webhook).
  await page.setViewportSize({ width: 1600, height: 1000 })
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

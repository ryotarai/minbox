// The shared proxy helpers (../minbox/hooks/proxy.ts) with the server's real guards
// (plugin/testdata/manifest-*.json): the JavaScript patterns the server serves are tested here, where
// a JavaScript engine runs them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { argsOf, guardDeny, manifestOf, pendingOf, serverUrlOf } from '../minbox/hooks/proxy.ts'

const load = (kind: string) => manifestOf(JSON.parse(readFileSync(new URL(`../testdata/manifest-${kind}.json`, import.meta.url), 'utf8')))!

test('the guards refuse commands that open a page on the host, and only those', () => {
  for (const [kind, tool] of [['claude', 'Bash'], ['pi', 'bash'], ['opencode', 'shell']] as const) {
    const m = load(kind)
    for (const c of [
      'open https://github.com/o/r/pull/1',
      "open 'https://x.dev'",
      'cd /w && open -a "Google Chrome" https://x.dev',
      'xdg-open http://localhost:3000',
      'gh pr view 12 --web',
      'gh pr create --fill -w',
      'gh browse',
      'gh run view 99 --web; echo done',
    ]) {
      const deny = guardDeny(m.guards, tool, c)
      assert.ok(deny?.includes('open_url'), `${kind}: ${c}`)
    }
    for (const c of ['gh pr view --json url -q .url', 'open README.md', 'echo open https://x', 'git push -u origin main', 'grep -w open file', 'gh pr list --state open']) {
      assert.equal(guardDeny(m.guards, tool, c), null, `${kind}: ${c}`)
    }
    assert.equal(guardDeny(m.guards, 'read', 'open https://x'), null)
  }
})

test("OpenCode's question tool is refused in the main session only", () => {
  const m = load('opencode')
  assert.match(guardDeny(m.guards, 'question', [], true)!, /minbox_send_message/)
  assert.equal(guardDeny(m.guards, 'question', [], false), null)
  assert.ok(guardDeny(m.guards, 'bash', ['ls', 'open https://x'], true))
})

test('the parsers take what the server sends and refuse anything else', () => {
  assert.equal(serverUrlOf('{"url":"http://127.0.0.1:4848/"}'), 'http://127.0.0.1:4848')
  assert.equal(serverUrlOf('{"url":"file:///x"}'), null)
  assert.equal(serverUrlOf('nope'), null)
  assert.equal(manifestOf([]), null)
  assert.equal(load('claude').tools.length, 12)
  assert.deepEqual(pendingOf({ items: [{ id: 'a', text: 'x' }, { id: 'b' }], joiner: '|' }), { items: [{ id: 'a', text: 'x' }], joiner: '|' })
  assert.equal(pendingOf([]), null) // a protocol-0 list
  assert.deepEqual(argsOf({ tool: 'x', tool_use_id: 'i', body: 'b' }, ['tool', 'tool_use_id']), { body: 'b' })
})

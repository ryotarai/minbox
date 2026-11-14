// A mock OpenAI-compatible server for testing OpenCode without a real model provider.
// Listens on 127.0.0.1 (port from $PORT, 0 = ephemeral), prints "LISTENING <port>" and serves
//   GET  /v1/models
//   POST /v1/chat/completions   (stream or not)
// Behaviour: it answers "mock reply: <last user text>" after an optional delay (MOCK_DELAY_MS).
// A user message that contains `CALL <tool> <json>` makes it call that tool once; after the tool
// result it answers "mock done". Every request body is appended as one JSON line to $MOCK_LOG.
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const log = process.env.MOCK_LOG
const delay = Number(process.env.MOCK_DELAY_MS ?? 0)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
  return ''
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (req.url?.startsWith('/v1/models')) {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }))
    return
  }
  if (!req.url?.startsWith('/v1/chat/completions')) {
    res.statusCode = 404
    res.end('{}')
    return
  }
  let body = {}
  try {
    body = JSON.parse(raw)
  } catch {
    /* keep {} */
  }
  if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), url: req.url, body }) + '\n')
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const last = msgs[msgs.length - 1]
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  const userText = textOf(lastUser?.content)
  // SLEEP<ms> in the last user text makes this answer slow (a long turn, for "Send now").
  const slow = /SLEEP(\d+)/.exec(userText)
  await sleep(slow && last?.role !== 'tool' ? Number(slow[1]) : delay)
  let content = null
  let toolCall = null
  if (last?.role === 'tool') {
    content = 'mock done'
  } else {
    const m = /CALL (\S+) (\{.*?\})\s*(?:$|\n)/s.exec(userText.replace(/\\"/g, '"'))
    // $THREAD in the arguments is the thread_id of a delivered minbox inbox message.
    const thread = /\(thread_id: (thr_[A-Za-z0-9_]+)\)/.exec(userText)?.[1] ?? ''
    if (m) toolCall = { name: m[1], args: m[2].replaceAll('$THREAD', thread) }
    else content = 'mock reply: ' + userText.replace(/\s+/g, ' ').slice(0, 200)
  }
  // Title requests and the like are answered the same way; they are harmless.
  const id = 'chatcmpl-mock'
  const base = { id, object: 'chat.completion.chunk', created: 1, model: body.model ?? 'mock-model' }
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish) => res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish ?? null }] }) + '\n\n')
    send({ role: 'assistant', content: '' })
    if (toolCall) {
      send({ tool_calls: [{ index: 0, id: 'call_mock1', type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] })
      send({}, 'tool_calls')
    } else {
      send({ content })
      send({}, 'stop')
    }
    res.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } else {
    res.setHeader('content-type', 'application/json')
    const message = toolCall
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_mock1', type: 'function', function: { name: toolCall.name, arguments: toolCall.args } }] }
      : { role: 'assistant', content }
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
  }
})

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  console.log('LISTENING ' + server.address().port)
})

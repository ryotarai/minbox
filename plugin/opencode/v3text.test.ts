// The v3 wording shared by the three integrations (../minbox/hooks/text.ts, tasks.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendRequest, wakeText, sentText } from '../minbox/hooks/text.ts'
import { taskLines, taskRequest, taskText } from '../minbox/hooks/tasks.ts'

test('a stream message asks the agent to decide; one written from a task names its tasks', () => {
  const base = { thread_id: 'thr_s', author: 'user' as const, created_at: '', subject: '', new_thread: false, stream: true }
  const plain = wakeText([{ ...base, id: 'm1', body: 'fix the gauge' }], 'minbox_send_message', 'minbox_read_thread')
  assert.match(plain, /a message from the person \(message m1\)/)
  assert.match(plain, /existing task .*task_ids.*new work \(create_task/)
  assert.doesNotMatch(plain, /thread_id/)
  const tagged = wakeText([{ ...base, id: 'm2', body: 'status?', tasks: [{ task_id: 'tsk_1', title: 'Fix gauge', status: 'working' }] }], 's', 'r')
  assert.match(tagged, /Tasks: tsk_1 "Fix gauge" \(they wrote it about these tasks\)/)
  const cont = wakeText([{ ...base, id: 'm3', kind: 'continue', body: 'minbox goal (autonomous run, turn 1 of 20): go' }], 's', 'r')
  assert.equal(cont, 'minbox goal (autonomous run, turn 1 of 20): go')
})

test('send_message needs only a body; the reply says what it was tagged with', () => {
  assert.deepEqual(sendRequest({ body: ' ' }), { error: 'body is required.' })
  assert.deepEqual(sendRequest({ body: 'x', task_ids: ['a', 3], subject: 'old' }), { body: { body: 'x', task_ids: ['a'], thread_title: 'old' } })
  assert.match(sentText({ thread_id: 't', new_thread: false, task_ids: ['tsk_1'] }), /Tagged with task tsk_1\./)
})

test('goals: create with criteria, tick them, read them back', () => {
  const r = taskRequest('update_task', { task_id: 'g', check_criteria: [1, 'x'] })
  assert.deepEqual(r, { method: 'PATCH', path: '/api/agent/tasks/g', body: { check_criteria: [1] } })
  const lines = taskLines({ id: 'g', kind: 'goal', status: 'working', title: 'CI green', auto: { state: 'running' }, steps: [{ text: 'a', steps: [{ text: 'b', done: true }] }], criteria: [{ text: 'CI passes', done: false }] })
  assert.deepEqual(lines, ['- goal g [working] [autonomous run on] CI green', '  1. [ ] a', '    2. [x] b', '  Done when:', '  c1. [ ] CI passes'])
  assert.match(taskText('create_task', { task_id: 'g', task: { id: 'g', kind: 'goal', status: 'working', title: 'CI' } }), /^Goal created \(task_id g\)/)
})

import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({ gfm: true, breaks: false })

/** Renders Markdown to sanitized HTML. */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
}

export type Segment =
  | { kind: 'md'; text: string }
  | { kind: 'question'; index: number }
  | { kind: 'actions'; start: number; count: number }

const OPEN = /^\s*:::\s*(question(?:-multi|-text)?|actions)\s*$/
const CLOSE = /^\s*:::\s*$/
const CHOICE = /^\s*(?:[-*+]|\d+[.)])\s+/
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s+\S/
const REC = /^\s*(?:Recommended|Recommendation|➡️|->|=>|→)\s*:?/

/**
 * Splits an agent message into Markdown, its question blocks and its action
 * blocks, numbered in the order the server parsed them (a question block with
 * no prompt line is not a question; an actions block yields one per item).
 */
export function splitQuestions(body: string): Segment[] {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: Segment[] = []
  let buf: string[] = []
  let index = 0
  let fence = false
  const flush = () => {
    const text = buf.join('\n')
    if (text.trim()) out.push({ kind: 'md', text })
    buf = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().startsWith('```')) fence = !fence
    const m = fence ? null : OPEN.exec(line)
    if (!m) {
      buf.push(line)
      continue
    }
    let j = i + 1
    const block: string[] = []
    for (; j < lines.length && !CLOSE.test(lines[j]!); j++) block.push(lines[j]!)
    if (m[1] === 'actions') {
      const count = block.filter((l) => TASK.test(l)).length
      if (count > 0) {
        flush()
        out.push({ kind: 'actions', start: index, count })
        index += count
      }
    } else {
      const valid = block.some((l) => l.trim() !== '' && !CHOICE.test(l) && !REC.test(l))
      if (valid) {
        flush()
        out.push({ kind: 'question', index: index++ })
      }
    }
    i = j
  }
  flush()
  return out
}

/** Strips question/action blocks: a message's prose, for one-line previews. */
export function proseOf(body: string): string {
  return splitQuestions(body)
    .filter((s) => s.kind === 'md')
    .map((s) => (s as { text: string }).text)
    .join('\n')
}

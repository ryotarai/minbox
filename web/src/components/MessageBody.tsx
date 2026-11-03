import { useLayoutEffect, useMemo, useRef } from 'react'
import { api, type Attachment, type Message } from '../api'
import { renderMarkdown } from '../lib/markdown'
import { Diagram } from './Diagram'
import { HtmlEmbed } from './HtmlEmbed'
import { cx } from './ui'

// A message's Markdown with Plannotator's extras (spec §5): ```mermaid and
// ```dot diagrams, ```html live pages, ```svg pictures, the images the message
// showed (captured when sent), and links to its attached files, which open
// beside the thread.

type Part = { kind: 'md'; text: string } | { kind: 'fence'; lang: string; code: string }

const DIAGRAM: Record<string, 'mermaid' | 'graphviz'> = { mermaid: 'mermaid', dot: 'graphviz', graphviz: 'graphviz', gv: 'graphviz' }
const SPECIAL = new Set(['mermaid', 'dot', 'graphviz', 'gv', 'html', 'svg'])
const SVG_MAX_CHARS = 512 * 1024

/** Splits out the fenced blocks drawn specially (first word of the info, lowercased). */
export function splitFences(src: string): Part[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: Part[] = []
  let buf: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i]!)
    if (!open) {
      buf.push(lines[i]!)
      continue
    }
    const fence = open[2]!
    const lang = open[3]!.toLowerCase()
    let j = i + 1
    while (j < lines.length && !new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[j]!)) j++
    const block = lines.slice(i, Math.min(j + 1, lines.length))
    if (SPECIAL.has(lang)) {
      if (buf.join('\n').trim()) out.push({ kind: 'md', text: buf.join('\n') })
      buf = []
      out.push({ kind: 'fence', lang, code: lines.slice(i + 1, j).join('\n') })
    } else buf.push(...block)
    i = j
  }
  if (buf.join('\n').trim()) out.push({ kind: 'md', text: buf.join('\n') })
  return out
}

function normalize(p: string): string {
  const abs = p.startsWith('/')
  const parts: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return (abs ? '/' : '') + parts.join('/')
}

/** The attachment a local link names (spec §5.3), or null. */
export function attachmentForLink(href: string, attachments: Attachment[], baseDir: string): Attachment | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return null
  const raw = href.replace(/[?#].*$/s, '')
  const cands = new Set([raw])
  try {
    cands.add(decodeURIComponent(raw))
  } catch {
    /* keep raw */
  }
  for (const c of cands) {
    const full = c.startsWith('/') ? normalize(c) : normalize(`${baseDir}/${c}`)
    const hit = attachments.find((a) => normalize(a.path) === full || (a.named_path && normalize(a.named_path) === full))
    if (hit) return hit
  }
  for (const c of cands) {
    if (c.includes('/')) continue
    const same = attachments.filter((a) => a.name === c)
    if (same.length === 1) return same[0]!
  }
  return null
}

function isLocalSrc(src: string): boolean {
  return !!src && !/^(https?:|data:|blob:)/i.test(src) && !src.startsWith('//') && !src.startsWith('\\\\')
}

function MarkdownPart({
  text,
  message,
  baseDir,
  onOpen,
  className,
}: {
  text: string
  message: Message
  baseDir: string
  onOpen: (a: Attachment) => void
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const html = useMemo(() => renderMarkdown(text), [text])
  const files = message.attachments ?? []
  const inline = message.inline_images ?? []
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    root.innerHTML = html
    // The images the message showed: the copies taken when it was sent.
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? ''
      if (!isLocalSrc(src)) {
        if (/^https?:|^\/\//i.test(src)) {
          img.replaceWith(Object.assign(document.createElement('span'), { className: 'text-[12px] text-subtle', textContent: `[remote image not shown: ${src}]` }))
        }
        continue
      }
      const cap = inline.find((a) => a.ref === src)
      if (cap) {
        img.setAttribute('src', api.messageImageUrl(message.id, src))
        img.dataset.attachment = cap.id
        img.classList.add('mb-inline-img')
        img.style.cursor = 'zoom-in'
      } else {
        img.replaceWith(Object.assign(document.createElement('span'), { className: 'text-[12px] text-subtle', textContent: `[image not shown: ${src}]` }))
      }
    }
    // Links to attached files open them beside the thread.
    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') ?? ''
      if (/^https?:/i.test(href)) {
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noreferrer')
        continue
      }
      const hit = attachmentForLink(href, [...files, ...inline], baseDir)
      if (hit) {
        ;(a as HTMLElement).dataset.attachment = hit.id
        a.setAttribute('title', `Open ${hit.path.replace(/^\/Users\/[^/]+/, '~')} beside the thread`)
      } else if (!href.startsWith('#')) {
        a.removeAttribute('href')
        a.setAttribute('title', 'Not attached to this message')
        a.classList.add('mb-inert-link')
      }
    }
  }, [html, files, inline, message.id, baseDir])
  return (
    <div
      ref={ref}
      className={cx('md', className)}
      onClick={(e) => {
        const el = (e.target as HTMLElement).closest('[data-attachment]') as HTMLElement | null
        if (!el) return
        const a = [...files, ...inline].find((x) => x.id === el.dataset.attachment)
        if (!a) return
        e.preventDefault()
        onOpen(a)
      }}
    />
  )
}

export function MessageBody({
  text,
  message,
  baseDir,
  onOpen,
  author,
  className,
}: {
  text: string
  message: Message
  baseDir: string
  onOpen: (a: Attachment) => void
  author: string
  className?: string
}) {
  const parts = useMemo(() => splitFences(text), [text])
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === 'md') return <MarkdownPart key={i} text={p.text} message={message} baseDir={baseDir} onOpen={onOpen} className={className} />
        if (DIAGRAM[p.lang]) return <Diagram key={i} language={DIAGRAM[p.lang]!} source={p.code} className="rounded-lg border border-line bg-surface p-3" />
        if (p.lang === 'html') return <HtmlEmbed key={i} html={p.code} author={author} />
        if (p.lang === 'svg' && p.code.includes('<svg') && p.code.length <= SVG_MAX_CHARS)
          return <img key={i} alt="SVG from the message" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(p.code)}`} className="max-w-full rounded-md" />
        return <MarkdownPart key={i} text={'```' + p.lang + '\n' + p.code + '\n```'} message={message} baseDir={baseDir} onOpen={onOpen} className={className} />
      })}
    </>
  )
}

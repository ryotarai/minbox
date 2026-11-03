import { useEffect, useRef, useState } from 'react'
import { api, type Annotation, type Attachment, type AttachmentDetail, type Message } from '../api'
import { changeState, formatBytes, kindLabel, opensBeside, sizeLine, typeOf, videoTime, viewsAsCode } from '../lib/attachments'
import { plural, shortTime } from '../lib/format'
import { Diagram } from './Diagram'
import { Kbd, cx } from './ui'

// Attachments at the foot of a message, and the thread's Artifacts grid
// (Plannotator's AttachmentTiles and Artifacts view; spec §7).

/** Details (changed? gone?) of a set of attachments, loaded once each. */
export function useDetails(items: Attachment[]): Record<string, AttachmentDetail> {
  const [d, setD] = useState<Record<string, AttachmentDetail>>({})
  const key = items.map((a) => a.id).join(',')
  useEffect(() => {
    let live = true
    for (const a of items) {
      if (a.kind === 'review') continue
      api
        .attachment(a.id)
        .then((x) => live && setD((m) => ({ ...m, [a.id]: x })))
        .catch(() => {})
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return d
}

function Icon({ a }: { a: Attachment }) {
  const t = typeOf(a)
  const glyph = t === 'html' || t === 'code' ? '</>' : t === 'mermaid' || t === 'graphviz' ? '◇' : t === 'video' ? '▶' : t === 'file' ? '▣' : t === 'image' ? '' : '≡'
  if (t === 'image')
    return <img alt="" src={api.attachmentRawUrl(a.id, 'sent')} className="h-[30px] w-[30px] shrink-0 rounded-[7px] object-cover" loading="lazy" />
  return (
    <span aria-hidden="true" className="mono flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[7px] bg-chip text-[11px] text-muted">
      {a.kind === 'review' ? '📖' : glyph}
    </span>
  )
}

export function AttachmentTiles({
  items,
  annotations,
  openId,
  newestId,
  onOpen,
}: {
  items: Attachment[]
  annotations: Annotation[]
  openId: string | null
  newestId: string | null
  onOpen: (a: Attachment) => void
}) {
  const details = useDetails(items)
  const files = items.filter((a) => a.kind === 'review' || typeOf(a) !== 'image')
  const images = items.filter((a) => a.kind !== 'review' && typeOf(a) === 'image')
  const changed = items.filter((a) => changeState(details[a.id])).length
  const comments = (a: Attachment) => annotations.filter((x) => x.attachment_id === a.id).length
  return (
    <div className="flex flex-col gap-1.5" data-testid="attachments">
      <span className="text-[12px] text-muted">
        📎 {plural(items.length, 'attachment')}
        {changed > 0 && <span className="text-wait"> · {changed} changed</span>}
      </span>
      {images.length > 0 && (
        <div className="flex gap-2 overflow-hidden" data-testid="image-gallery">
          {images.map((a) => {
            const ratio = a.width && a.height ? Math.min(4, Math.max(0.62, a.width / a.height)) : 1.5
            const ch = changeState(details[a.id])
            return (
              <button
                key={a.id}
                type="button"
                data-testid="attachment-card"
                aria-label={`View ${a.name}, ${kindLabel(a)}${ch ? `, ${ch.long}` : ''}${comments(a) ? `, ${plural(comments(a), 'comment')}` : ''}`}
                onClick={() => onOpen(a)}
                className={cx('relative flex min-w-0 flex-col overflow-hidden rounded-[10px] border bg-card text-left', a.id === openId ? 'border-accent' : 'border-line2')}
                style={{ flex: `${ratio} 1 0`, maxWidth: 240 * ratio }}
              >
                <img alt={a.name} src={api.attachmentRawUrl(a.id, 'sent')} loading="lazy" className="max-h-[240px] w-full object-cover" style={{ aspectRatio: String(ratio) }} />
                <span className="flex flex-col gap-px px-2.5 py-1.5">
                  <span className="truncate text-[12.5px] font-semibold">{a.name}</span>
                  <span className={cx('truncate text-[11px]', ch ? 'text-wait' : 'text-subtle')} title={ch?.long}>
                    {ch ? ch.short : sizeLine(a)}
                    {comments(a) > 0 && `, ${plural(comments(a), 'annotation')}`}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((a) => {
            const ch = changeState(details[a.id])
            const open = a.id === openId
            const base = cx('flex min-w-[220px] flex-1 items-center gap-2.5 rounded-[10px] border bg-card px-3 py-2.5 text-left no-underline hover:border-linestrong', open ? 'border-accent bg-wait/6' : 'border-line2')
            const body = (
              <>
                <Icon a={a} />
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="truncate text-[13px] font-semibold text-fg">{a.kind === 'review' ? 'Guided review' : a.name}</span>
                  <span className={cx('truncate text-[11.5px]', ch ? 'text-wait' : 'text-subtle')} title={ch?.long}>
                    {a.kind === 'review' ? a.name : ch ? ch.short : sizeLine(a)}
                    {comments(a) > 0 && (typeOf(a) === 'video' ? ` · ${plural(comments(a), 'comment')}` : `, ${plural(comments(a), 'annotation')}`)}
                  </span>
                </span>
                {a.id === newestId && <Kbd>O</Kbd>}
                <span className="text-[12.5px] font-semibold text-wait">
                  {a.kind !== 'review' && !opensBeside(a) ? 'Download' : open ? 'Open beside' : typeOf(a) === 'video' ? 'Play' : 'Open'}
                </span>
              </>
            )
            if (a.kind !== 'review' && !opensBeside(a))
              return (
                <a key={a.id} href={api.attachmentDownloadUrl(a.id)} download={a.name} data-testid="attachment-card" aria-label={`Download ${a.name}`} className={base}>
                  {body}
                </a>
              )
            return (
              <button
                key={a.id}
                type="button"
                data-testid="attachment-card"
                aria-current={open ? 'true' : undefined}
                aria-label={open ? `${a.name}, open beside the thread` : `${typeOf(a) === 'video' ? 'Play' : 'Open'} ${a.name}`}
                onClick={() => onOpen(a)}
                className={base}
              >
                {body}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- Artifacts grid ----

type ArtifactRow = { a: Attachment; m: Message }

export function ArtifactsGrid({
  messages,
  annotations,
  sessionName,
  onOpen,
}: {
  messages: Message[]
  annotations: Annotation[]
  sessionName: string
  onOpen: (a: Attachment) => void
}) {
  const rows: ArtifactRow[] = []
  for (const m of [...messages].reverse()) {
    const files = m.attachments ?? []
    const paths = new Set(files.map((a) => a.path))
    for (const a of m.inline_images ?? []) if (!paths.has(a.path)) rows.push({ a, m })
    for (const a of files) rows.push({ a, m })
  }
  const details = useDetails(rows.map((r) => r.a))
  const msgCount = new Set(rows.map((r) => r.m.id)).size
  if (rows.length === 0)
    return (
      <div className="flex flex-col items-center gap-2 px-6 py-12 text-center" data-testid="artifacts-empty">
        <span className="text-[15px] font-semibold">No artifacts in this thread yet</span>
        <span className="max-w-[320px] text-[13px] leading-normal text-muted">Files, images and guided reviews an agent sends, and files you paste into a reply, show here.</span>
      </div>
    )
  return (
    <div className="flex flex-col gap-3" data-testid="artifacts">
      <span className="text-[12px] text-subtle">{rows.length === 1 ? '1 artifact' : `${rows.length} from ${plural(msgCount, 'message')} · newest first`}</span>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {rows.map(({ a, m }) => {
          const ch = changeState(details[a.id])
          const n = annotations.filter((x) => x.attachment_id === a.id).length
          const from = m.author === 'agent' ? `Claude Code` : 'You'
          const detail = a.kind === 'review' ? 'Guided review' : typeOf(a) === 'image' && a.width ? `${kindLabel(a)}, ${a.width} × ${a.height}, ${formatBytes(a.size)}` : sizeLine(a)
          const label = [a.name, detail, `from ${from} at ${shortTime(m.created_at)}`, a.inline ? 'shown in the message text' : '', ch ? ch.long.toLowerCase() : '', n ? plural(n, 'comment') : ''].filter(Boolean).join(', ')
          const download = a.kind !== 'review' && !opensBeside(a)
          const inner = (
            <>
              <Preview a={a} />
              <span className="flex flex-col gap-0.5 px-2.5 py-2">
                <span className="truncate text-[13px] font-semibold">{a.kind === 'review' ? 'Guided review' : a.name}</span>
                <span className="truncate text-[11.5px] text-subtle">{detail}</span>
                <span className="truncate text-[11.5px] text-subtle">
                  {from === 'You' ? 'You' : `${from} in ${sessionName}`} · {shortTime(m.created_at)}
                  {a.inline && ' · shown in the message text'}
                </span>
                {ch && <span className="text-[11.5px] text-wait">{ch.short === 'Changed type' || ch.short === 'No longer on disk' ? ch.short : 'Changed since sent'}</span>}
                {n > 0 && <span className="text-[11.5px] text-muted">💬 {plural(n, 'comment')}</span>}
              </span>
            </>
          )
          const cls = 'flex flex-col overflow-hidden rounded-[10px] border border-line2 bg-card text-left no-underline text-fg hover:border-linestrong'
          return download ? (
            <a key={a.id} href={api.attachmentDownloadUrl(a.id)} download={a.name} aria-label={`Download ${label}`} className={cls} data-testid="artifact">
              {inner}
            </a>
          ) : (
            <button key={a.id} type="button" aria-label={label} className={cls} onClick={() => onOpen(a)} data-testid="artifact">
              {inner}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** A tile's preview, loaded when it comes near the viewport. */
function Preview({ a }: { a: Attachment }) {
  const ref = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const t = typeOf(a)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!near || a.kind === 'review') return
    if (t === 'html') api.attachmentView(a.id, 'sent').then((v) => setHtml(v.html ?? v.text)).catch(() => {})
    else if (['markdown', 'text', 'code', 'mermaid', 'graphviz'].includes(t))
      api
        .attachment(a.id)
        .then((d) => setText((d.text_sent ?? '').slice(0, 256 * 1024)))
        .catch(() => {})
  }, [near, a.id, a.kind, t])
  const box = 'h-[120px] w-full shrink-0 overflow-hidden border-b border-line bg-sunken'
  if (a.kind === 'review') return <div ref={ref} className={cx(box, 'flex items-center justify-center text-[28px]')}>📖</div>
  return (
    <div ref={ref} className={box}>
      {!near ? null : t === 'image' ? (
        <img alt="" src={api.attachmentRawUrl(a.id, 'sent')} className="h-full w-full object-cover" />
      ) : t === 'video' ? (
        <div className="relative h-full w-full">
          <video src={`${api.attachmentRawUrl(a.id, 'sent')}#t=0.1`} preload="metadata" muted className="h-full w-full object-cover" />
          {a.duration_ms ? <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[11px] text-white">{videoTime(a.duration_ms / 1000)}</span> : null}
        </div>
      ) : t === 'html' && html !== null ? (
        <iframe title="" sandbox="" srcDoc={html} className="pointer-events-none h-[480px] w-[200%] origin-top-left scale-50 border-0 bg-white" tabIndex={-1} />
      ) : (t === 'mermaid' || t === 'graphviz') && text !== null ? (
        <div className="pointer-events-none origin-top-left scale-[0.5] p-2" style={{ width: '200%' }}>
          <Diagram language={t} source={text} />
        </div>
      ) : text !== null && (t === 'markdown' || t === 'text' || viewsAsCode(a)) ? (
        <pre className="mono m-0 p-2 text-[10.5px] leading-[1.45] text-fg2">
          {text
            .split('\n')
            .slice(0, 14)
            .map((l) => (l.length > 160 ? l.slice(0, 160) : l))
            .join('\n')}
        </pre>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-muted">
          <span className="mono text-[18px] font-bold">{(/\.([^.]+)$/.exec(a.name)?.[1] ?? 'FILE').toUpperCase().slice(0, 5)}</span>
        </div>
      )}
    </div>
  )
}

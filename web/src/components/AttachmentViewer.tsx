import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, uploadMarkup, type Annotation, type Attachment, type AttachmentDetail } from '../api'
import { useApp } from '../lib/app'
import { kindLabel, sizeLine, steppable, typeOf, videoTime, viewsAsCode } from '../lib/attachments'
import { updateReplyDraft, useReplyDraft } from '../lib/drafts'
import { hm, plural } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { renderMarkdown } from '../lib/markdown'
import { Diagram } from './Diagram'
import { IconClose, IconComment, IconExpand, IconImage, IconPen, IconSelect } from './icons'
import { Button, IconButton, Kbd, MenuItem, MenuLabel, Popover, cx } from './ui'
import { useThread } from './ThreadView'

// An attachment opened beside the thread: each kind in its own viewer, with
// comments that go back in the reply (Plannotator's AttachmentPane; spec §3, §4).

type Version = 'current' | 'sent'
type Pending = Omit<Annotation, 'comment'> & { x: number; y: number }

const MARKUP_ONLY_TEXT = 'See the marked-up image.'
const CODE_HIGHLIGHT_MAX_CHARS = 100_000
const CODE_WRAP_LINE_CHARS = 1000
const FOLD_PANEL_BELOW = 780

export function AttachmentViewer({ attachmentId, sessionName, sessionCwd, phone }: { attachmentId: string; sessionName: string; sessionCwd: string; phone?: boolean }) {
  const { navigate, error, route } = useApp()
  const [detail, setDetail] = useState<AttachmentDetail | null>(null)
  const [version, setVersion] = useState<Version>('current')
  const [full, setFull] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [listAnchor, setListAnchor] = useState<HTMLElement | null>(null)
  const [openAnchor, setOpenAnchor] = useState<HTMLElement | null>(null)
  const [paneW, setPaneW] = useState(1000)
  const [sheet, setSheet] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setDetail(null)
    setPending(null)
    api
      .attachment(attachmentId)
      .then((d) => {
        if (!live) return
        setDetail(d)
        // A file that is gone, or no longer that kind of file, opens as sent.
        setVersion(d.exists && !d.unavailable ? 'current' : 'sent')
      })
      .catch(error)
    return () => {
      live = false
    }
  }, [attachmentId, error])

  useLayoutEffect(() => {
    const el = paneRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setPaneW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const [thread] = useThread(detail?.thread_id ?? null)
  const siblings = useMemo(() => steppable(thread?.messages ?? []), [thread])
  const draft = useReplyDraft(detail?.thread_id ?? '_')
  const annotations = draft.annotations.filter((a) => a.attachment_id === attachmentId)
  const sender = detail?.author === 'user' ? 'you' : 'Claude Code'
  const idx = siblings.findIndex((a) => a.id === attachmentId)

  // On a phone the viewer was pushed as a history entry: closing goes back through it (no stacked entries).
  const close = () => (phone && history.state?.viewer ? history.back() : navigate({ f: null }, { push: false }))
  const step = (d: 1 | -1) => {
    if (siblings.length < 2) return
    const next = siblings[(idx + d + siblings.length) % siblings.length]
    if (next) navigate({ f: next.id }, { push: false })
  }
  useHotkeys({
    f: () => setFull((v) => !v),
    ']': () => step(1),
    '[': () => step(-1),
    arrowright: () => step(1),
    arrowleft: () => step(-1),
    escape: () => {
      if (pending) setPending(null)
      else if (sheet) setSheet(false)
      else if (full) setFull(false)
      else close()
    },
  })

  const addAnnotation = (a: Annotation) => {
    if (!detail) return
    updateReplyDraft(detail.thread_id, (d) => ({ ...d, annotations: [...d.annotations, { ...a, attachment_id: detail.id, name: detail.name, version, at: Date.now() }] }))
  }
  const savePending = (comment: string, images?: { path: string; name: string }[]) => {
    if (!pending) return
    const { x: _x, y: _y, ...rest } = pending
    void _x
    void _y
    addAnnotation({ ...rest, comment, images: [...(rest.images ?? []), ...(images ?? [])] })
    setPending(null)
    window.getSelection()?.removeAllRanges()
  }

  const t = detail ? typeOf(detail) : null
  const folded = phone || paneW < FOLD_PANEL_BELOW

  return (
    <div ref={paneRef} className={cx('relative flex min-w-0 bg-sunken', phone ? 'min-h-0 flex-1' : 'h-full', full && !phone && 'fixed inset-0 z-40')} data-testid="attachment-viewer" data-type={t ?? ''}>
      <div className="flex min-w-0 flex-1 flex-col">
        {phone ? (
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line bg-surface pl-4 pr-1.5" data-testid="phone-viewer-header">
            <span className="min-w-0 flex-1 truncate text-[15.5px] font-[650]">{detail?.name ?? '…'}</span>
            {siblings.length > 1 && (
              <button type="button" onClick={(e) => setListAnchor(e.currentTarget)} className="mono h-11 shrink-0 border-0 bg-transparent px-1.5 text-[12.5px] text-muted">
                {idx + 1}/{siblings.length} ⌄
              </button>
            )}
            <button type="button" onClick={(e) => setOpenAnchor(e.currentTarget)} className="h-11 shrink-0 border-0 bg-transparent px-2 text-[13px] text-muted">
              Open in ▾
            </button>
            <button type="button" aria-label="Close file" data-testid="close-file" onClick={close} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2">
              <IconClose size={20} />
            </button>
          </div>
        ) : (
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line bg-surface pl-4 pr-2.5">
          <div role="tablist" className="flex min-w-0 gap-0.5 rounded-lg bg-bg p-[3px]">
            <button type="button" role="tab" aria-selected={false} data-testid="tab-terminal" onClick={close} className="h-7 shrink-0 rounded-[6px] border-0 bg-transparent px-2.5 text-[12.5px] text-muted hover:text-fg">
              Terminal
            </button>
            <button type="button" role="tab" aria-selected className="h-7 min-w-0 max-w-[260px] truncate rounded-[6px] border-0 bg-sel px-2.5 text-[12.5px] font-semibold">
              {detail?.name ?? '…'}
            </button>
          </div>
          <span className="hidden truncate text-[12.5px] text-subtle xl:inline">from {detail?.author === 'user' ? 'you' : `Claude Code in ${sessionName}`}</span>
          <span className="flex-1" />
          {siblings.length > 1 && (
            <button type="button" onClick={(e) => setListAnchor(e.currentTarget)} className="mono shrink-0 border-0 bg-transparent text-[12px] text-muted hover:text-fg" title="] and [ step through the files">
              {idx + 1}/{siblings.length} ⌄
            </button>
          )}
          <Button size="sm" onClick={(e) => setOpenAnchor(e.currentTarget)}>
            Open in ▾
          </Button>
          <Button size="sm" onClick={() => setFull((v) => !v)} data-testid="fullscreen">
            <IconExpand size={13} /> {full ? 'Exit full screen' : 'Full screen'} <Kbd>F</Kbd>
          </Button>
          <IconButton aria-label="Close file" data-testid="close-file" onClick={close}>
            <IconClose />
          </IconButton>
        </div>
        )}
        <Popover anchor={listAnchor} open={!!listAnchor} onClose={() => setListAnchor(null)} className="w-[280px]">
          <MenuLabel>Files in this thread</MenuLabel>
          {siblings.map((a, i) => (
            <MenuItem key={a.id} active={a.id === attachmentId} hint={`${i + 1} of ${siblings.length}`} onClick={() => (setListAnchor(null), navigate({ f: a.id }, { push: false }))}>
              {a.name}
            </MenuItem>
          ))}
        </Popover>
        <Popover anchor={openAnchor} open={!!openAnchor} onClose={() => setOpenAnchor(null)}>
          {detail && (
            <>
              <MenuItem onClick={() => (window.location.href = `vscode://file${detail.path}`)}>VS Code</MenuItem>
              <MenuItem onClick={() => (window.location.href = `cursor://file${detail.path}`)}>Cursor</MenuItem>
              <MenuItem onClick={() => window.open(api.attachmentDownloadUrl(detail.id, version), '_blank')}>Download</MenuItem>
              <MenuItem onClick={() => (void navigator.clipboard?.writeText(detail.path), setOpenAnchor(null))}>Copy path</MenuItem>
            </>
          )}
        </Popover>

        {detail && <VersionLine d={detail} version={version} sender={sender} onVersion={setVersion} />}

        <div ref={bodyRef} className={cx('relative min-h-0 flex-1 overflow-auto', phone ? 'px-3 py-3 [touch-action:pan-x_pan-y_pinch-zoom]' : 'px-7 py-[18px]')} data-testid="attachment-body">
          {!detail || !t ? (
            <div className="text-[13px] text-subtle">Loading…</div>
          ) : t === 'pdf' || t === 'file' ? (
            <DownloadCard d={detail} />
          ) : t === 'image' ? (
            <ImageView d={detail} version={version} onComment={(p) => setPending(p)} onMarkup={addAnnotation} />
          ) : t === 'video' ? (
            <VideoView d={detail} version={version} annotations={annotations} onComment={(p) => setPending(p)} />
          ) : t === 'html' ? (
            <HtmlView d={detail} version={version} bodyRef={bodyRef} onPin={(p) => setPending(p)} />
          ) : t === 'mermaid' || t === 'graphviz' ? (
            <DiagramView d={detail} version={version} bodyRef={bodyRef} onPart={(p) => setPending(p)} />
          ) : viewsAsCode(detail) ? (
            <CodeView d={detail} version={version} annotations={annotations} bodyRef={bodyRef} onLines={(p) => setPending(p)} />
          ) : (
            <DocView d={detail} version={version} quotes={annotations.map((a) => a.quote ?? '')} bodyRef={bodyRef} onComment={(p) => setPending(p)} sessionCwd={sessionCwd} />
          )}

          {pending && <CommentBox phone={phone} pending={pending} onCancel={() => setPending(null)} onSave={savePending} />}
        </div>
      </div>

      {folded ? (
        <>
          <button
            type="button"
            onClick={() => setSheet((v) => !v)}
            className={cx('absolute z-10 rounded-lg border border-linestrong bg-overlay px-3 shadow-pop', phone ? 'bottom-[max(12px,env(safe-area-inset-bottom))] right-3 h-11 text-[14px]' : 'bottom-3 right-3 h-9 text-[12.5px]')}
            data-testid="comments-toggle"
          >
            Comments {annotations.length}
          </button>
          {sheet && (
            <aside data-testid="comments-sheet" className={cx('absolute z-10 overflow-y-auto border border-linestrong bg-surface shadow-pop', phone ? 'inset-x-0 bottom-0 max-h-[65%] rounded-t-xl pb-[calc(60px+env(safe-area-inset-bottom))]' : 'bottom-14 right-3 max-h-[60%] w-[300px] rounded-xl')}>
              <CommentsPanel annotations={annotations} threadId={detail?.thread_id ?? ''} pending={pending} onSeek={seekVideo} />
            </aside>
          )}
        </>
      ) : (
        <aside aria-label="Annotations" className="flex w-[300px] shrink-0 flex-col border-l border-line bg-surface">
          <CommentsPanel annotations={annotations} threadId={detail?.thread_id ?? ''} pending={pending} onSeek={seekVideo} />
        </aside>
      )}
      <span className="hidden">{route.f}</span>
    </div>
  )
}

function seekVideo(time: number) {
  const v = document.querySelector<HTMLVideoElement>('[data-testid="attachment-viewer"] video')
  if (v) {
    v.currentTime = time
    v.pause()
  }
}

function VersionLine({ d, version, sender, onVersion }: { d: AttachmentDetail; version: Version; sender: string; onVersion: (v: Version) => void }) {
  const sentAt = hm(d.created_at)
  const Sender = sender === 'you' ? 'you' : 'Claude Code'
  if (d.unavailable)
    return (
      <div role="status" data-testid="changed-banner" className="flex shrink-0 items-center gap-2.5 border-b border-line bg-raised px-4 py-[9px] text-[12.5px] text-fg2">
        {d.unavailable.message} This is the version {Sender} sent at {sentAt}.
      </div>
    )
  if (version === 'sent' && d.changed)
    return (
      <div role="status" data-testid="changed-banner" className="flex shrink-0 items-center gap-2.5 border-b border-wait/25 bg-wait/8 px-4 py-[9px] text-[12.5px] text-fg2">
        <span aria-hidden="true" className="text-wait">
          ⓘ
        </span>
        <span>
          The version {Sender} sent at {sentAt}.
        </span>
        <button type="button" onClick={() => onVersion('current')} className="border-0 bg-transparent p-0 text-wait underline">
          Open the file as it is now
        </button>
      </div>
    )
  if (d.changed)
    return (
      <div role="status" data-testid="changed-banner" className="flex shrink-0 items-center gap-2.5 border-b border-wait/25 bg-wait/8 px-4 py-[9px] text-[12.5px] text-fg2">
        <span aria-hidden="true" className="text-wait">
          ⓘ
        </span>
        <span>
          Changed since {Sender} sent it at {sentAt}.{d.modified_at ? ` Edited ${hm(d.modified_at)}.` : ''}
        </span>
        <button type="button" onClick={() => onVersion('sent')} className="border-0 bg-transparent p-0 text-wait underline">
          {sender === 'you' ? 'Open the version you sent' : 'Open the version it sent'}
        </button>
      </div>
    )
  return null
}

function DownloadCard({ d }: { d: AttachmentDetail }) {
  return (
    <div data-download-card data-testid="download-card" className="mx-auto mt-10 flex max-w-[460px] flex-col items-center gap-3 rounded-xl border border-line2 bg-card p-6 text-center">
      <span className="text-[30px]">{typeOf(d) === 'pdf' ? '📄' : '📦'}</span>
      <span className="text-[15px] font-semibold">{d.name}</span>
      <span className="text-[13px] leading-normal text-muted">
        {kindLabel(d)}, {sizeLine(d).split(', ').pop()}. minbox does not show this kind of file; download it to open it.
      </span>
      <a href={api.attachmentDownloadUrl(d.id)} download={d.name} className="flex h-9 items-center rounded-md bg-accent px-4 text-[13px] font-[650] text-onaccent no-underline">
        Download
      </a>
    </div>
  )
}

// ---- documents (markdown, text) ----

function DocView({
  d,
  version,
  quotes,
  bodyRef,
  onComment,
  sessionCwd,
}: {
  d: AttachmentDetail
  version: Version
  quotes: string[]
  bodyRef: React.RefObject<HTMLDivElement | null>
  onComment: (p: Pending) => void
  sessionCwd: string
}) {
  const [tool, setTool] = useState<'select' | 'comment'>('select')
  const [linked, setLinked] = useState<{ name: string; text: string } | null>(null)
  const text = version === 'current' ? (d.text_current ?? d.text_sent ?? '') : (d.text_sent ?? '')
  const shown = linked?.text ?? text
  const ref = useRef<HTMLElement>(null)
  const html = useMemo(() => renderMarkdown(typeOf(d) === 'text' && /\.txt$/i.test(d.name) ? shown : stripFrontmatter(shown)), [shown, d])
  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    root.innerHTML = html
    // Images the document references, relative to its folder.
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const src = img.getAttribute('src') ?? ''
      if (src && !/^(https?:|data:|blob:|\/\/)/i.test(src)) img.setAttribute('src', api.markdownImageUrl(d.id, src, version))
    }
    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      const href = a.getAttribute('href') ?? ''
      if (/^https?:/i.test(href)) a.setAttribute('target', '_blank')
      else if (/\.(mdx?|html?)$/i.test(href.replace(/[?#].*$/, ''))) (a as HTMLElement).dataset.linked = href
    }
    if (!linked) for (const q of quotes) if (q) highlight(root, q)
  }, [html, d.id, version, linked, quotes.join('\u0000')])
  void sessionCwd
  // Select: selecting words is ordinary (copy them), with a small "Comment"
  // button beside the selection. Comment: selecting words opens the comment at
  // once, and a click on a paragraph, heading, item or row comments on all of it.
  const [offer, setOffer] = useState<Pending | null>(null)
  useEffect(() => setOffer(null), [tool, html])
  const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,pre,tr,blockquote'
  const onMouseUp = (e: React.MouseEvent) => {
    if (linked) return
    const box = bodyRef.current?.getBoundingClientRect()
    if (!box) return
    const top = bodyRef.current?.scrollTop ?? 0
    const sel = window.getSelection()
    const t = sel?.toString().trim()
    if (t) {
      const r = sel!.getRangeAt(0).getBoundingClientRect()
      const p: Pending = { kind: 'comment', quote: t.slice(0, 300), x: r.left - box.left, y: r.bottom - box.top + top + 8 }
      if (tool === 'comment') onComment(p)
      else setOffer(p)
      return
    }
    setOffer(null)
    if (tool !== 'comment' || (e.target as HTMLElement).closest('a')) return
    const el = (e.target as HTMLElement).closest(BLOCKS) as HTMLElement | null
    if (!el || !ref.current?.contains(el)) return
    const r = el.getBoundingClientRect()
    onComment({ kind: 'comment', quote: el.innerText.trim().slice(0, 300), x: Math.min(r.left - box.left + 40, box.width - 400), y: r.bottom - box.top + top + 8 })
  }
  return (
    <>
      <div className="mb-[18px] flex items-center gap-3">
        <div className="inline-flex gap-0.5 rounded-[9px] border border-line2 bg-raised p-[3px]" role="toolbar" aria-label="Annotation tools">
          <ToolBtn on={tool === 'select'} onClick={() => setTool('select')} label="Select" title="Select text to copy it or comment on it">
            <IconSelect size={14} /> Select
          </ToolBtn>
          <ToolBtn on={tool === 'comment'} onClick={() => setTool('comment')} label="Comment" title="Click a paragraph, or select words, to comment">
            <IconComment size={14} />
            {tool === 'comment' && 'Comment'}
          </ToolBtn>
        </div>
        <span className="text-[12px] text-subtle" data-testid="doc-tool-hint">
          {tool === 'select' ? 'Select text to comment on it.' : 'Click a paragraph or select words to comment.'}
        </span>
      </div>
      {offer && (
        <button
          type="button"
          data-testid="doc-comment-selection"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onComment(offer)
            setOffer(null)
          }}
          style={{ left: Math.max(0, offer.x), top: offer.y - 4 }}
          className="absolute z-20 flex h-7 items-center gap-1.5 rounded-[7px] border border-line2 bg-raised px-2.5 text-[12.5px] text-fg shadow-lg hover:bg-sel"
        >
          <IconComment size={13} /> Comment
        </button>
      )}
      {linked && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-line2 bg-raised px-3 py-2 text-[12.5px] text-fg2">
          <button type="button" onClick={() => setLinked(null)} className="border-0 bg-transparent p-0 text-wait underline">
            Back to {d.name}
          </button>
          <span className="text-subtle">`{linked.name}` is not attached, so comments are off.</span>
        </div>
      )}
      <article
        ref={ref}
        onMouseUp={onMouseUp}
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest('[data-linked]') as HTMLElement | null
          if (!el) return
          e.preventDefault()
          api
            .linkedPage(d.id, el.dataset.linked!)
            .then((p) => setLinked({ name: p.name, text: p.text }))
            .catch(() => {})
        }}
        className={cx(
          'md max-w-[640px] text-[14.5px] leading-[1.7] [&_h1]:text-[24px]',
          tool === 'comment' &&
            !linked &&
            'cursor-default [&_:is(p,li,h1,h2,h3,h4,h5,h6,pre,tr,blockquote):hover]:rounded-[4px] [&_:is(p,li,h1,h2,h3,h4,h5,h6,pre,tr,blockquote):hover]:bg-wait/10 [&_:is(p,li,h1,h2,h3,h4,h5,h6,pre,tr,blockquote):hover]:outline [&_:is(p,li,h1,h2,h3,h4,h5,h6,pre,tr,blockquote):hover]:outline-1 [&_:is(p,li,h1,h2,h3,h4,h5,h6,pre,tr,blockquote):hover]:outline-wait/40',
        )}
        data-testid="doc"
      />
    </>
  )
}

function stripFrontmatter(s: string): string {
  return s.replace(/^---\n[\s\S]*?\n---\n/, '')
}

function highlight(root: HTMLElement, quote: string) {
  const needle = quote.split('\n')[0]!.trim()
  if (!needle) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const i = node.textContent?.indexOf(needle) ?? -1
    if (i < 0) continue
    const range = document.createRange()
    range.setStart(node, i)
    range.setEnd(node, i + needle.length)
    const mark = document.createElement('mark')
    mark.className = 'mb-anno-saved'
    range.surroundContents(mark)
    return
  }
}

// ---- code ----

const LANG_MAP: Record<string, string> = { h: 'c', hpp: 'cpp', ex: 'elixir', exs: 'elixir', tf: 'hcl', mjs: 'js', cjs: 'js', mts: 'ts', cts: 'ts', yml: 'yaml', jsonc: 'jsonc', json5: 'json5', conf: 'ini', cfg: 'ini', properties: 'properties', gv: 'dot', mmd: 'mermaid' }
const NAME_MAP: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'make', justfile: 'just', rakefile: 'ruby', gemfile: 'ruby', vagrantfile: 'ruby', brewfile: 'ruby', procfile: 'text' }

function langOf(name: string): string {
  const lower = name.toLowerCase()
  if (NAME_MAP[lower]) return NAME_MAP[lower]!
  const m = /\.([^.]+)$/.exec(lower)
  if (!m) return 'text'
  return LANG_MAP[m[1]!] ?? m[1]!
}

type Tok = { content: string; color?: string }

function CodeView({
  d,
  version,
  annotations,
  bodyRef,
  onLines,
}: {
  d: AttachmentDetail
  version: Version
  annotations: Annotation[]
  bodyRef: React.RefObject<HTMLDivElement | null>
  onLines: (p: Pending) => void
}) {
  const text = version === 'current' ? (d.text_current ?? d.text_sent ?? '') : (d.text_sent ?? '')
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  const [tokens, setTokens] = useState<Tok[][] | null>(null)
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null)
  const { toast } = useApp()
  const wrap = lines.some((l) => l.length > CODE_WRAP_LINE_CHARS)
  useEffect(() => {
    setTokens(null)
    if (text.length > CODE_HIGHLIGHT_MAX_CHARS) return
    let live = true
    const dark = document.documentElement.dataset.theme !== 'light'
    import('shiki')
      .then(async ({ codeToTokens, bundledLanguages }) => {
        const lang = langOf(d.name)
        const r = await codeToTokens(text.replace(/\n$/, ''), { lang: (lang in bundledLanguages ? lang : 'text') as never, theme: dark ? 'github-dark' : 'github-light' })
        if (live) setTokens(r.tokens.map((l) => l.map((t) => ({ content: t.content, color: t.color }))))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [text, d.name])
  const commented = new Set<number>()
  for (const a of annotations) if (a.line_start) for (let i = a.line_start; i <= (a.line_end ?? a.line_start); i++) commented.add(i)

  const commentOn = (a: number, b: number, rect: DOMRect) => {
    const [s, e] = a <= b ? [a, b] : [b, a]
    const first = lines.slice(s - 1, e).find((l) => l.trim()) ?? ''
    const quote = first.trim().slice(0, 120) + (e > s ? ' …' : '')
    const box = bodyRef.current!.getBoundingClientRect()
    onLines({ kind: 'comment', quote, line_start: s, line_end: e, x: 80, y: rect.bottom - box.top + (bodyRef.current?.scrollTop ?? 0) + 6 })
  }
  const lineOf = (n: Node | null): number | null => {
    const el = (n instanceof Element ? n : n?.parentElement)?.closest('[data-line]') as HTMLElement | null
    return el ? Number(el.dataset.line) : null
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-[12px] text-subtle">
        <Button
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(text)
            toast('Copied the file')
          }}
        >
          Copy file
        </Button>
        <span>Click a line number, drag across lines, or select code to comment.</span>
      </div>
      <div
        className="mono overflow-x-auto rounded-[10px] border border-line bg-bg text-[12.5px] leading-[1.75]"
        data-testid="code"
        onMouseUp={() => {
          const sel = window.getSelection()
          if (!sel || sel.isCollapsed || !sel.toString().trim()) return
          const a = lineOf(sel.anchorNode)
          const b = lineOf(sel.focusNode)
          if (a && b) commentOn(a, b, sel.getRangeAt(0).getBoundingClientRect())
        }}
      >
        {lines.map((l, i) => {
          const n = i + 1
          const inDrag = drag && n >= Math.min(drag.a, drag.b) && n <= Math.max(drag.a, drag.b)
          return (
            <div key={i} data-line={n} className={cx('flex', commented.has(n) && 'bg-work/12', inDrag && 'bg-wait/15')}>
              <span
                role="button"
                tabIndex={-1}
                data-testid="code-line-number"
                onMouseDown={(e) => {
                  e.preventDefault()
                  setDrag({ a: n, b: n })
                }}
                onMouseEnter={() => drag && setDrag({ ...drag, b: n })}
                onMouseUp={(e) => {
                  if (!drag) return
                  commentOn(drag.a, n, (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect())
                  setDrag(null)
                }}
                className="w-12 shrink-0 cursor-default select-none pr-3.5 text-right text-faint hover:text-wait"
              >
                {n}
              </span>
              <span className={cx('text-fg2', wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre')}>
                {tokens?.[i]
                  ? tokens[i]!.map((t, j) => (
                      <span key={j} style={{ color: t.color }}>
                        {t.content}
                      </span>
                    ))
                  : l || ' '}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---- html ----

const ANNOTATE_SCRIPT = `<script>(function(){var on=false,last=null;function mark(el){if(last)last.style.outline=last.__o||'';last=el;if(el){el.__o=el.style.outline;el.style.outline='2px solid #f2b14a'}}
addEventListener('message',function(e){if(e.data&&e.data.mbAnnotate!==undefined){on=!!e.data.mbAnnotate;if(!on)mark(null)}});
document.addEventListener('mouseover',function(e){if(on)mark(e.target)},true);
document.addEventListener('click',function(e){if(!on)return;e.preventDefault();e.stopPropagation();var el=e.target,r=el.getBoundingClientRect();
parent.postMessage({mbPin:1,tag:el.tagName.toLowerCase(),text:(el.innerText||el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,200),x:r.left,y:r.bottom},'*')},true)})()</script>`

function HtmlView({ d, version, bodyRef, onPin }: { d: AttachmentDetail; version: Version; bodyRef: React.RefObject<HTMLDivElement | null>; onPin: (p: Pending) => void }) {
  const [doc, setDoc] = useState<string | null>(null)
  const [mode, setMode] = useState<'annotate' | 'interact'>('interact')
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    api
      .attachmentView(d.id, version)
      .then((v) => setDoc((v.html ?? v.text) + ANNOTATE_SCRIPT))
      .catch(() => setDoc(null))
  }, [d.id, version])
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ mbAnnotate: mode === 'annotate' }, '*')
  }, [mode, doc])
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const m = e.data as { mbPin?: number; tag: string; text: string; x: number; y: number }
      if (m?.mbPin !== 1) return
      const fr = frame.current!.getBoundingClientRect()
      const box = bodyRef.current!.getBoundingClientRect()
      onPin({ kind: 'element', quote: m.text ? `${m.tag}: ${m.text}` : `<${m.tag}>`, x: Math.min(fr.left - box.left + m.x, box.width - 400), y: fr.top - box.top + m.y + (bodyRef.current?.scrollTop ?? 0) + 8 })
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [bodyRef, onPin])
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="inline-flex self-start gap-0.5 rounded-[9px] border border-line2 bg-raised p-[3px]" role="toolbar">
        <ToolBtn on={mode === 'interact'} onClick={() => setMode('interact')} label="Interact">
          Interact
        </ToolBtn>
        <ToolBtn on={mode === 'annotate'} onClick={() => setMode('annotate')} label="Annotate">
          <IconComment size={14} /> Annotate
        </ToolBtn>
      </div>
      {doc === null ? (
        <span className="text-[13px] text-subtle">Loading…</span>
      ) : (
        <iframe
          ref={frame}
          title={d.name}
          srcDoc={doc}
          sandbox="allow-scripts allow-modals"
          onLoad={() => frame.current?.contentWindow?.postMessage({ mbAnnotate: mode === 'annotate' }, '*')}
          className="min-h-[480px] w-full flex-1 rounded-lg border border-line bg-white"
          data-testid="html-view"
        />
      )}
    </div>
  )
}

// ---- diagrams ----

function DiagramView({ d, version, bodyRef, onPart }: { d: AttachmentDetail; version: Version; bodyRef: React.RefObject<HTMLDivElement | null>; onPart: (p: Pending) => void }) {
  const text = version === 'current' ? (d.text_current ?? d.text_sent ?? '') : (d.text_sent ?? '')
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] text-subtle">Click a node, edge or group to comment on it.</span>
      <Diagram
        language={typeOf(d) === 'mermaid' ? 'mermaid' : 'graphviz'}
        source={text}
        className="rounded-lg border border-line bg-surface p-4"
        onPart={(t, r) => {
          const box = bodyRef.current!.getBoundingClientRect()
          onPart({ kind: 'diagram', quote: t, x: Math.min(r.left - box.left, box.width - 400), y: r.bottom - box.top + (bodyRef.current?.scrollTop ?? 0) + 8 })
        }}
      />
    </div>
  )
}

// ---- image ----

type Stroke = { tool: 'pen' | 'arrow' | 'circle'; pts: [number, number][] }

function ImageView({ d, version, onComment, onMarkup }: { d: AttachmentDetail; version: Version; onComment: (p: Pending) => void; onMarkup: (a: Annotation) => void }) {
  const { error, toast } = useApp()
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [markup, setMarkup] = useState(false)
  const [tool, setTool] = useState<Stroke['tool']>('pen')
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [note, setNote] = useState('')
  const imgRef = useRef<HTMLImageElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cur = useRef<Stroke | null>(null)
  const src = api.attachmentRawUrl(d.id, version)
  const wide = d.width && d.height ? d.width / d.height >= 4 : false

  const redraw = () => {
    const c = canvasRef.current
    const img = imgRef.current
    if (!c || !img) return
    c.width = img.clientWidth
    c.height = img.clientHeight
    const g = c.getContext('2d')!
    const sx = img.clientWidth / (img.naturalWidth || 1)
    for (const s of [...strokes, ...(cur.current ? [cur.current] : [])]) drawStroke(g, s, sx, 2.5)
  }
  useEffect(redraw)

  const finish = async () => {
    const img = imgRef.current
    if (!img || strokes.length === 0) return
    try {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const g = c.getContext('2d')!
      g.drawImage(img, 0, 0)
      for (const s of strokes) drawStroke(g, s, 1, Math.max(3, img.naturalWidth / 300))
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not draw the image'))), 'image/png'))
      const up = await uploadMarkup(blob)
      const stem = d.name.replace(/\.[^.]+$/, '')
      onMarkup({ kind: 'pen', quote: d.name, comment: note.trim() || MARKUP_ONLY_TEXT, images: [{ path: up.path, name: `${stem}, marked up` }] })
      toast('Added the marked-up image as a comment')
      setStrokes([])
      setNote('')
      setMarkup(false)
    } catch (err) {
      error(err)
    }
  }

  const pos = (e: React.PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect()
    const img = imgRef.current!
    const s = img.naturalWidth / r.width
    return [(e.clientX - r.left) * s, (e.clientY - r.top) * s]
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-0.5 rounded-[9px] border border-line2 bg-raised p-[3px]">
          <ToolBtn on={zoom === 'fit'} onClick={() => setZoom('fit')} label="Fit">
            Fit
          </ToolBtn>
          <ToolBtn on={zoom === 1} onClick={() => setZoom(1)} label="Actual size">
            Actual size
          </ToolBtn>
        </div>
        <Button size="sm" onClick={() => onComment({ kind: 'comment', quote: d.name, x: 40, y: 60 })} data-testid="image-comment">
          <IconComment size={13} /> Comment
        </Button>
        <Button size="sm" onClick={() => setMarkup((v) => !v)} title="Draw on the image (pen, arrow, circle)" data-testid="image-markup">
          <IconPen size={13} /> Mark up
        </Button>
        <span className="text-[12px] text-subtle">{sizeLine(d)}</span>
      </div>
      {markup && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line2 bg-raised p-2" data-testid="markup-bar">
          {(['pen', 'arrow', 'circle'] as const).map((t) => (
            <ToolBtn key={t} on={tool === t} onClick={() => setTool(t)} label={t}>
              {t === 'pen' ? 'Pen' : t === 'arrow' ? 'Arrow' : 'Circle'}
            </ToolBtn>
          ))}
          <Button size="sm" variant="quiet" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}>
            Undo
          </Button>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="h-[30px] min-w-0 flex-1 rounded-md border border-linestrong bg-sunken px-2 text-[12.5px] outline-none focus:border-accent" />
          <Button size="sm" variant="primary" onClick={() => void finish()} disabled={!strokes.length} data-testid="markup-done">
            ✓
          </Button>
        </div>
      )}
      <div
        className={cx('relative self-start', wide && 'max-w-full overflow-x-auto')}
        onWheel={(e) => {
          if (!(e.ctrlKey || e.metaKey)) return
          e.preventDefault()
          const base = zoom === 'fit' ? (imgRef.current ? imgRef.current.clientWidth / imgRef.current.naturalWidth : 1) : zoom
          setZoom(Math.min(8, Math.max(0.1, base * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
        }}
        onDoubleClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')}
      >
        <img
          ref={imgRef}
          src={src}
          alt={d.name}
          onLoad={redraw}
          data-testid="image-view"
          className="block rounded-md border border-line"
          style={zoom === 'fit' ? { maxWidth: wide ? 'none' : '100%', maxHeight: wide ? 480 : undefined } : { width: (d.width ?? imgRef.current?.naturalWidth ?? 0) * zoom, maxWidth: 'none' }}
        />
        <canvas
          ref={canvasRef}
          className={cx('absolute inset-0', markup ? 'cursor-crosshair' : 'pointer-events-none')}
          onPointerDown={(e) => {
            if (!markup) return
            ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
            cur.current = { tool, pts: [pos(e)] }
          }}
          onPointerMove={(e) => {
            if (!cur.current) return
            const p = pos(e)
            if (cur.current.tool === 'pen') cur.current.pts.push(p)
            else cur.current.pts[1] = p
            redraw()
          }}
          onPointerUp={() => {
            if (cur.current && cur.current.pts.length > 1) setStrokes((s) => [...s, cur.current!])
            cur.current = null
          }}
        />
      </div>
    </div>
  )
}

function drawStroke(g: CanvasRenderingContext2D, s: Stroke, scale: number, width: number) {
  g.strokeStyle = '#ff3b30'
  g.lineWidth = width
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const p = s.pts.map(([x, y]) => [x * scale, y * scale] as [number, number])
  if (p.length < 2) return
  g.beginPath()
  if (s.tool === 'pen') p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)))
  else if (s.tool === 'circle') {
    const [a, b] = [p[0]!, p[p.length - 1]!]
    g.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2)
  } else {
    const [a, b] = [p[0]!, p[p.length - 1]!]
    g.moveTo(a[0], a[1])
    g.lineTo(b[0], b[1])
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
    const h = width * 5
    g.moveTo(b[0], b[1])
    g.lineTo(b[0] - h * Math.cos(ang - 0.45), b[1] - h * Math.sin(ang - 0.45))
    g.moveTo(b[0], b[1])
    g.lineTo(b[0] - h * Math.cos(ang + 0.45), b[1] - h * Math.sin(ang + 0.45))
  }
  g.stroke()
}

// ---- video ----

function VideoView({ d, version, annotations, onComment }: { d: AttachmentDetail; version: Version; annotations: Annotation[]; onComment: (p: Pending) => void }) {
  const { error } = useApp()
  const v = useRef<HTMLVideoElement>(null)
  const commentHere = async () => {
    const el = v.current
    if (!el) return
    el.pause()
    const time = Math.round(el.currentTime * 1000) / 1000
    let images: { path: string; name: string }[] = []
    try {
      const c = document.createElement('canvas')
      c.width = el.videoWidth
      c.height = el.videoHeight
      c.getContext('2d')!.drawImage(el, 0, 0)
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('no frame'))), 'image/png'))
      const up = await uploadMarkup(blob)
      images = [{ path: up.path, name: `${d.name.replace(/\.[^.]+$/, '')} at ${videoTime(time)}` }]
    } catch (err) {
      error(err)
    }
    onComment({ kind: 'video', quote: `${d.name} at ${videoTime(time)}`, time, images, x: 40, y: (el.clientHeight || 300) + 70 })
  }
  return (
    <div className="flex flex-col gap-2.5">
      <video ref={v} src={api.attachmentRawUrl(d.id, version)} controls preload="metadata" className="max-h-[70vh] max-w-full rounded-md border border-line bg-black" data-testid="video-view" />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void commentHere()} data-testid="video-comment">
          <IconComment size={13} /> Comment at this moment
        </Button>
        <span className="text-[12px] text-subtle">
          {sizeLine(d)}
          {annotations.length > 0 && ` · ${plural(annotations.length, 'comment')}`}
        </span>
      </div>
    </div>
  )
}

// ---- comment box & panel ----

function CommentBox({ phone, pending, onCancel, onSave }: { phone?: boolean; pending: Pending; onCancel: () => void; onSave: (comment: string, images?: { path: string; name: string }[]) => void }) {
  const { error } = useApp()
  const [text, setText] = useState('')
  const [big, setBig] = useState(false)
  const [images, setImages] = useState<{ path: string; name: string }[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const loc = pending.line_start ? (pending.line_end && pending.line_end !== pending.line_start ? `lines ${pending.line_start}–${pending.line_end}` : `line ${pending.line_start}`) : pending.time !== undefined ? videoTime(pending.time) : ''
  const save = () => {
    const t = text.trim() || (images.length || pending.images?.length ? MARKUP_ONLY_TEXT : '')
    if (t) onSave(t, images)
  }
  return (
    <div
      className={cx('absolute z-10 flex flex-col rounded-xl border border-[#3a3a42] bg-overlay shadow-pop', phone ? 'inset-x-2' : big ? 'w-[560px]' : 'w-[380px]')}
      style={{ left: phone ? undefined : Math.max(8, pending.x), top: pending.y }}
      data-testid="annotation-box"
      onMouseUp={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2 border-b border-line2 px-3 py-2.5 text-[12.5px] text-muted">
        <span className="min-w-0 flex-1 truncate">
          {pending.quote ? `"${pending.quote}"` : 'Comment'}
          {loc ? ` · ${loc}` : ''}
        </span>
        <button type="button" aria-label="Expand" onClick={() => setBig((v) => !v)} className="border-0 bg-transparent text-muted hover:text-fg">
          ⤢
        </button>
        <button type="button" aria-label="Cancel" onClick={onCancel} className="border-0 bg-transparent text-muted hover:text-fg">
          ×
        </button>
      </div>
      <textarea
        autoFocus
        aria-label="Comment"
        data-testid="annotation-input"
        value={text}
        placeholder={pending.kind === 'comment' && pending.quote && !pending.line_start ? 'Comment on this…' : 'Comment…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save()
          if (e.key === 'Escape') {
            e.stopPropagation()
            if (!text.trim() || window.confirm('Discard this comment?')) onCancel()
          }
        }}
        className={cx('resize-none border-0 bg-transparent px-3 py-2.5 text-[13.5px] text-fg outline-none', big ? 'h-[180px]' : 'h-[72px]')}
      />
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3">
          {images.map((im) => (
            <span key={im.path} className="mono rounded bg-chip px-1.5 text-[11px]">
              {im.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-2">
        <button type="button" aria-label="Attach image" title="Attach an image" onClick={() => fileRef.current?.click()} className="border-0 bg-transparent p-0 text-muted hover:text-fg">
          <IconImage size={16} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            try {
              const up = await uploadMarkup(f)
              setImages((x) => [...x, { path: up.path, name: f.name }])
            } catch (err) {
              error(err)
            }
          }}
        />
        <span className="flex-1" />
        <Button size="sm" variant="primary" data-testid="annotation-save" disabled={!text.trim() && !images.length && !pending.images?.length} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  )
}

function CommentsPanel({ annotations, threadId, pending, onSeek }: { annotations: Annotation[]; threadId: string; pending: Pending | null; onSeek: (t: number) => void }) {
  const sorted = [...annotations].sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4 text-[13.5px] font-semibold">
        Annotations <span className="rounded-full bg-sel px-[7px] text-[11px] leading-[18px]">{annotations.length}</span>
      </div>
      <div className="flex flex-col gap-3.5 overflow-y-auto px-4 py-3" data-testid="annotation-list">
        {annotations.length === 0 && !pending && <span className="text-[12.5px] leading-normal text-subtle">Select text, a line, a part or a moment, and comment. Comments go with your reply.</span>}
        {sorted.map((a, i) => (
          <AnnotationItem key={i} a={a} threadId={threadId} onSeek={onSeek} />
        ))}
        {pending && (
          <div className="flex flex-col gap-1 opacity-85">
            <span className="text-[12px]">
              <b className="font-[650] text-work">Draft</b> <span className="text-subtle">not saved</span>
            </span>
            {pending.quote && <span className="mono text-[11.5px] text-muted">"{pending.quote.slice(0, 80)}"</span>}
          </div>
        )}
      </div>
    </>
  )
}

function AnnotationItem({ a, threadId, onSeek }: { a: Annotation; threadId: string; onSeek: (t: number) => void }) {
  const [editing, setEditing] = useState(false)
  const [v, setV] = useState(a.comment)
  const update = (fn: (list: Annotation[]) => Annotation[]) => updateReplyDraft(threadId, (d) => ({ ...d, annotations: fn(d.annotations) }))
  const loc = a.line_start ? (a.line_end && a.line_end !== a.line_start ? `lines ${a.line_start}–${a.line_end}` : `line ${a.line_start}`) : ''
  return (
    <div className="flex flex-col gap-1" data-testid="annotation">
      <span className="text-[12px]">
        <b className="font-[650] text-wait">{a.kind === 'pen' ? 'Mark-up' : a.kind === 'video' ? 'Moment' : 'Comment'}</b>{' '}
        <span className="text-subtle">
          you{a.at ? ` · ${hm(new Date(a.at))}` : ''}
          {loc ? ` · ${loc}` : ''}
          {a.version === 'sent' ? ' · sent version' : ''}
        </span>
      </span>
      {a.quote && <span className="mono text-[11.5px] text-muted">"{a.quote.slice(0, 80)}"</span>}
      {a.time !== undefined && (
        <button type="button" onClick={() => onSeek(a.time!)} className="self-start border-0 bg-transparent p-0 text-[12px] text-wait underline">
          Go to {videoTime(a.time)}
        </button>
      )}
      {editing ? (
        <textarea value={v} autoFocus onChange={(e) => setV(e.target.value)} className="h-16 resize-none rounded-md border border-accent bg-sunken p-2 text-[13px] outline-none" />
      ) : (
        <span className="text-[13px] leading-[1.55]">{a.comment}</span>
      )}
      {a.images?.map((im) => (
        <span key={im.path} className="mono text-[11px] text-subtle">
          🖼 {im.name}
        </span>
      ))}
      <span className="flex gap-2 text-[12px] text-subtle">
        <button
          type="button"
          className="border-0 bg-transparent p-0 hover:text-fg"
          onClick={() => {
            if (editing) update((l) => l.map((x) => (x === a || (x.at === a.at && x.comment === a.comment) ? { ...x, comment: v } : x)))
            setEditing(!editing)
          }}
        >
          {editing ? 'Save' : 'Edit'}
        </button>
        ·
        <button type="button" className="border-0 bg-transparent p-0 hover:text-fg" onClick={() => update((l) => l.filter((x) => !(x.at === a.at && x.comment === a.comment && x.attachment_id === a.attachment_id)))}>
          Remove
        </button>
      </span>
    </div>
  )
}

function ToolBtn({ on, onClick, label, title, children }: { on: boolean; onClick: () => void; label: string; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-pressed={on}
      onClick={onClick}
      className={cx('flex h-[30px] min-w-8 items-center justify-center gap-1.5 rounded-[6px] border-0 px-2 text-[12.5px]', on ? 'bg-sel text-fg' : 'bg-transparent text-muted hover:text-fg')}
    >
      {children}
    </button>
  )
}

export type { Attachment }

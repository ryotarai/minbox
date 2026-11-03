import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { Button, IconButton, cx } from './ui'
import { IconClose } from './icons'

// A ```html block in a message, drawn as a live page in a sandbox
// (Plannotator's HtmlEmbedBlock; spec §5.1).

const EMBED_MAX_BYTES = 512 * 1024
const EMBED_FIRST_HEIGHT = 120
const EMBED_MAX_HEIGHT = 20000
const EMBED_CLIP_PX = 480
const EMBED_SANDBOX = 'allow-scripts allow-forms'
const THEME_TOKENS = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--muted',
  '--muted-foreground',
  '--primary',
  '--primary-foreground',
  '--accent',
  '--accent-foreground',
  '--border',
  '--destructive',
  '--success',
  '--warning',
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--font-sans',
  '--font-mono',
  '--radius',
]

/** The theme as the embed's CSS variables, from minbox's tokens. */
function themeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (n: string) => cs.getPropertyValue(n).trim()
  const map: Record<string, string> = {
    '--background': v('--mb-bg'),
    '--foreground': v('--mb-fg'),
    '--card': v('--mb-card'),
    '--card-foreground': v('--mb-fg'),
    '--muted': v('--mb-raised'),
    '--muted-foreground': v('--mb-muted'),
    '--primary': v('--mb-accent'),
    '--primary-foreground': v('--mb-onaccent'),
    '--accent': v('--mb-sel'),
    '--accent-foreground': v('--mb-fg'),
    '--border': v('--mb-line2'),
    '--destructive': v('--mb-danger'),
    '--success': v('--mb-ok'),
    '--warning': v('--mb-wait'),
    '--chart-1': '#4f6bed',
    '--chart-2': '#e8833a',
    '--chart-3': '#2fa37a',
    '--chart-4': '#d64c63',
    '--chart-5': '#8b5cf6',
    '--font-sans': "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', sans-serif",
    '--font-mono': "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    '--radius': '8px',
  }
  const out: Record<string, string> = {}
  for (const k of THEME_TOKENS) out[k] = map[k] ?? ''
  return out
}

function scheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

export function HtmlEmbed({ html, author }: { html: string; author: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [height, setHeight] = useState(EMBED_FIRST_HEIGHT)
  const [expanded, setExpanded] = useState(false)
  const [code, setCode] = useState(false)
  const [full, setFull] = useState(false)
  const [near, setNear] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const tooBig = new Blob([html]).size > EMBED_MAX_BYTES

  // Load when it comes near the viewport.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '400px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!near || tooBig) return
    let live = true
    api
      .embed(html)
      .then((r) => live && setUrl(r.url))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [near, html, tooBig])

  // The page reports its height and asks to open links.
  useEffect(() => {
    let heard = false
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return
      const d = e.data as { pnEmbed?: number; kind?: string; height?: number; url?: string }
      if (!d || d.pnEmbed !== 1) return
      heard = true
      if (d.kind === 'height' && typeof d.height === 'number') setHeight(Math.min(EMBED_MAX_HEIGHT, Math.max(0, Math.ceil(d.height))))
      if (d.kind === 'link' && typeof d.url === 'string' && /^https?:\/\//.test(d.url) && d.url.length <= 4096) window.open(d.url, '_blank', 'noopener,noreferrer')
      if (d.kind === 'escape') frameRef.current?.blur()
    }
    window.addEventListener('message', onMsg)
    // A page that never speaks falls back to its code.
    const t = url ? setTimeout(() => !heard && setFailed(true), 10_000) : null
    return () => {
      window.removeEventListener('message', onMsg)
      if (t) clearTimeout(t)
    }
  }, [url])

  const src = url ? `${url}#pn=${encodeURIComponent(JSON.stringify({ vars: themeVars(), scheme: scheme(), mode: full ? 'full' : 'inline' }))}` : null
  const clipped = !expanded && height > EMBED_CLIP_PX

  if (tooBig || failed || code) {
    return (
      <div className="flex flex-col gap-1">
        <pre className="mono max-h-[480px] overflow-auto rounded-lg border border-line bg-sunken p-3 text-[12px]">{html}</pre>
        {!tooBig && !failed && (
          <Caption author={author} onCode={() => setCode(false)} codeOn onFull={() => setFull(true)} />
        )}
      </div>
    )
  }
  return (
    <div ref={boxRef} className="flex flex-col gap-1" data-testid="html-embed">
      <div className="relative overflow-hidden rounded-lg border border-line" style={{ height: clipped ? EMBED_CLIP_PX : height }}>
        {src && (
          <iframe
            ref={frameRef}
            title="HTML from the message"
            src={src}
            sandbox={EMBED_SANDBOX}
            referrerPolicy="no-referrer"
            loading="lazy"
            className="block h-full w-full border-0"
            style={{ background: 'transparent', colorScheme: scheme(), height }}
          />
        )}
        {clipped && (
          <div className="absolute inset-x-0 bottom-0 flex h-20 items-end justify-center bg-gradient-to-b from-transparent to-[var(--mb-bg)] pb-2">
            <Button size="sm" onClick={() => setExpanded(true)}>
              Show more
            </Button>
          </div>
        )}
      </div>
      <Caption author={author} onCode={() => setCode(true)} onFull={() => setFull(true)} />
      {full &&
        src &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col bg-bg">
            <div className="flex h-12 items-center gap-2 border-b border-line px-4 text-[13px]">
              <span className="flex-1 font-semibold">HTML · sandboxed</span>
              <IconButton aria-label="Close" onClick={() => setFull(false)}>
                <IconClose />
              </IconButton>
            </div>
            <iframe title="HTML from the message, full screen" src={src.replace(/mode%22%3A%22inline/, 'mode%22%3A%22full')} sandbox={EMBED_SANDBOX} referrerPolicy="no-referrer" className="min-h-0 flex-1 border-0" />
          </div>,
          document.body,
        )}
    </div>
  )
}

function Caption({ author, onCode, onFull, codeOn }: { author: string; onCode: () => void; onFull: () => void; codeOn?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-subtle" title={`From ${author}. It runs in a sandbox and can load from the web.`}>
      <span>HTML · sandboxed</span>
      <span className="flex-1" />
      <button type="button" onClick={onCode} className={cx('border-0 bg-transparent p-0 hover:text-fg', codeOn && 'text-fg')}>
        Code
      </button>
      <button type="button" onClick={onFull} className="border-0 bg-transparent p-0 hover:text-fg">
        Full screen
      </button>
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { cx } from './ui'

// Mermaid and Graphviz diagrams, drawn in the page. The libraries load only
// when a diagram shows up.

let mermaidSeq = 0

async function renderMermaid(src: string): Promise<string> {
  const { default: mermaid } = await import('mermaid')
  const dark = document.documentElement.dataset.theme !== 'light'
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'ui-sans-serif, system-ui, sans-serif' })
  const { svg } = await mermaid.render(`mb-mermaid-${++mermaidSeq}`, src)
  return svg
}

let vizPromise: Promise<{ renderString: (src: string, opts: { format: 'svg'; engine?: string }) => string }> | null = null

async function renderGraphviz(src: string): Promise<string> {
  vizPromise ??= import('@viz-js/viz').then((m) => m.instance())
  const viz = await vizPromise
  return viz.renderString(src, { format: 'svg', engine: 'dot' })
}

export function Diagram({
  language,
  source,
  className,
  onPart,
}: {
  language: 'mermaid' | 'graphviz'
  source: string
  className?: string
  /** A click on a node, edge or cluster: its text (for comments). */
  onPart?: (text: string, rect: DOMRect) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setError(null)
    ;(language === 'mermaid' ? renderMermaid(source) : renderGraphviz(source))
      .then((svg) => {
        if (!live || !ref.current) return
        ref.current.innerHTML = svg
        const el = ref.current.querySelector('svg')
        if (el) {
          el.style.maxWidth = '100%'
          el.style.height = 'auto'
        }
      })
      .catch((e) => live && setError(String(e?.message ?? e)))
    return () => {
      live = false
    }
  }, [language, source])
  return (
    <div className={cx('relative', className)} data-testid="diagram" data-language={language}>
      {error ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-danger">The {language === 'mermaid' ? 'Mermaid' : 'Graphviz'} diagram did not draw: {error}</span>
          <pre className="mono overflow-x-auto rounded-md border border-line bg-sunken p-2 text-[12px]">{source}</pre>
        </div>
      ) : (
        <div
          ref={ref}
          className={cx('flex justify-center overflow-x-auto', onPart && '[&_.node]:cursor-pointer [&_.edgePath]:cursor-pointer [&_.cluster]:cursor-pointer [&_g.node]:cursor-pointer [&_g.edge]:cursor-pointer')}
          onClick={(e) => {
            if (!onPart) return
            const part = (e.target as Element).closest('g.node, g.edge, g.cluster, .node, .edgeLabel, .cluster')
            if (!part) return
            const text = (part.textContent ?? '').replace(/\s+/g, ' ').trim()
            if (text) onPart(text, part.getBoundingClientRect())
          }}
        />
      )}
    </div>
  )
}

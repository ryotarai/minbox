// v3's pane state and widths (main's App.tsx kept them in the layout: this browser, across reloads):
// the agent's side pane (tasks, terminal, shell, files) and the dragged widths of the sidebar and
// the side pane.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'
import type { SidePane } from './StreamView'

/** What an agent can show: a plain shell has no stream of its own, an ended agent no shell. */
function fit(p: SidePane, s: Session | undefined): SidePane {
  if (s?.kind === 'shell' && p !== 'files') return 'terminal'
  if (p === 'shell' && s?.status === 'ended') return 'tasks'
  return p
}

/**
 * The open agent's side pane. On a desktop or tablet the last one shown is kept (the terminal stays
 * open across agents and reloads, as main's terminal pane did); a phone starts on the stream. A link
 * with tab=terminal (older links) opens the terminal.
 */
export function useSidePane(current: Session | undefined): [SidePane, (p: SidePane) => void] {
  const { route, isPhone, layout, setLayout } = useApp()
  const initial = (): SidePane => fit(route.tab === 'terminal' ? 'terminal' : isPhone ? 'tasks' : layout.v3Pane ?? 'tasks', current)
  const [pane, setPaneState] = useState<SidePane>(initial)
  const known = !!current
  useEffect(() => {
    setPaneState(initial())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.s, route.tab, known])
  const setPane = useCallback(
    (p: SidePane) => {
      setPaneState(p)
      if (!isPhone) setLayout({ v3Pane: p })
    },
    [isPhone, setLayout],
  )
  return [pane, setPane]
}

/** A column edge: drag to resize. onDrag gets the pointer's move since the press (screen px) and the width the column had then. */
export function Resizer({ onDrag, measure, testid, className }: { onDrag: (dx: number, start: number) => void; measure: () => number; testid: string; className?: string }) {
  const start = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      aria-hidden="true"
      data-testid={testid}
      className={'v-rz' + (className ? ' ' + className : '')}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: measure() }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s) return
        onDrag(e.clientX - s.x, s.w)
      }}
      onPointerUp={() => (start.current = null)}
      onPointerCancel={() => (start.current = null)}
    />
  )
}

/** The text size zooms the page: a drag in screen pixels is this many CSS pixels. */
export function useZoom(): number {
  const { settings } = useApp()
  return (settings.text_size || 13) / 13
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

export function useWindowWidth(): number {
  const [w, setW] = useState(window.innerWidth)
  useEffect(() => {
    const on = () => setW(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return w
}

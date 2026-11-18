// v3's pane state and widths (main's App.tsx kept them in the layout: this browser, across reloads):
// the agent's side panes (terminal, shell, files) and the dragged widths of the sidebar and the panes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'

/** One of the agent's side panes. Each is shown or hidden on its own (its header button, its key); on a
 *  desktop several stand side by side, in this order after the stream. */
export type PaneKind = 'terminal' | 'shell' | 'files'
export const PANE_ORDER: readonly PaneKind[] = ['terminal', 'shell', 'files']
/** The phone sheet's tab: 'tasks' (the agent's tasks), or one of the panes. */
export type SidePane = 'tasks' | PaneKind

/** What an agent can show: a plain shell has no stream of its own (its terminal, or its files), an
 *  ended agent no shell. */
function fit(l: PaneKind[], s: Session | undefined): PaneKind[] {
  const out = l.filter((p) => !(p === 'shell' && (s?.kind === 'shell' || s?.status === 'ended')))
  return s?.kind === 'shell' && !out.length ? ['terminal'] : out
}

export type SidePanes = {
  /** The panes open, oldest opened first (which of them show is up to the room, see fitPanes). */
  open: PaneKind[]
  /** A tablet or a phone: one pane at a time (opening one replaces the other). */
  single: boolean
  /** Open it (open already: make it the one opened last). */
  show: (p: PaneKind) => void
  close: (p: PaneKind) => void
  /** That one alone ('tasks': none), as the phone sheet's tabs pick. */
  only: (p: SidePane) => void
}

/**
 * The open agent's side panes. On a desktop or tablet the open ones are kept (they stay open across
 * agents and reloads, as main's terminal pane did); a phone starts on the stream. A link with
 * tab=terminal (older links) opens the terminal.
 */
export function useSidePanes(current: Session | undefined): SidePanes {
  const { route, isPhone, isTablet, layout, setLayout } = useApp()
  const single = isPhone || isTablet
  const saved = (): PaneKind[] => (layout.v3Panes ?? (layout.v3Pane && layout.v3Pane !== 'tasks' ? [layout.v3Pane] : [])).filter((p) => PANE_ORDER.includes(p))
  const initial = (): PaneKind[] => {
    let l = isPhone ? [] : saved()
    if (route.tab === 'terminal') l = [...l.filter((p) => p !== 'terminal'), 'terminal']
    return fit(single ? l.slice(-1) : l, current)
  }
  const [open, setOpen] = useState<PaneKind[]>(initial)
  const known = !!current
  useEffect(() => {
    setOpen(initial())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.s, route.tab, known, isPhone, isTablet])
  const cur = useRef(current)
  cur.current = current
  const savedRef = useRef(saved)
  savedRef.current = saved
  const change = useCallback(
    (f: (l: PaneKind[]) => PaneKind[]) => {
      const s = cur.current
      setOpen((l) => fit(f(l), s))
      // A plain shell's panes are its own (not what other agents open with); a phone keeps none.
      if (!isPhone && s?.kind !== 'shell') setLayout({ v3Panes: f(savedRef.current()), v3Pane: undefined })
    },
    [isPhone, setLayout],
  )
  const show = useCallback((p: PaneKind) => change((l) => (single ? [p] : [...l.filter((x) => x !== p), p])), [change, single])
  const close = useCallback((p: PaneKind) => change((l) => l.filter((x) => x !== p)), [change])
  const only = useCallback((p: SidePane) => change(() => (p === 'tasks' ? [] : [p])), [change])
  return { open, single, show, close, only }
}

/** The narrowest a side pane gets (squeezed by the others, or dragged). */
export const MIN_PANE = 240
/** The narrowest the stream's messages get beside the side panes (else the Tasks pane folds to its strip). */
export const MIN_STREAM = 380

/**
 * Which of the open panes show, and how wide, in `room` (the width left for them beside a stream of
 * MIN_STREAM): the ones opened last first, as many as fit at MIN_PANE (always the last one opened); then
 * their dragged widths, squeezed alike toward MIN_PANE when they do not all fit. The others stay open
 * (their buttons unpressed) and come back when there is room again.
 */
export function fitPanes(open: PaneKind[], want: (p: PaneKind) => number, room: number): { shown: PaneKind[]; widths: Partial<Record<PaneKind, number>> } {
  const kept: PaneKind[] = []
  for (const p of [...open].reverse()) if (!kept.length || (kept.length + 1) * MIN_PANE <= room) kept.push(p)
  const total = kept.reduce((n, p) => n + want(p), 0)
  const floor = kept.length * MIN_PANE
  const k = total > room && total > floor ? Math.max(0, room - floor) / (total - floor) : 1
  const widths: Partial<Record<PaneKind, number>> = {}
  for (const p of kept) widths[p] = Math.round(k === 1 ? want(p) : MIN_PANE + (want(p) - MIN_PANE) * k)
  return { shown: PANE_ORDER.filter((p) => kept.includes(p)), widths }
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useApp } from '../lib/app'
import {
  PALETTE,
  WIDTHS,
  arrowHead,
  blobToDataUrl,
  constrain,
  moveShape,
  normBox,
  onSketchRequest,
  pathOf,
  rasterize,
  shapeBounds,
  sketchName,
  textSize,
  type Scene,
  type Shape,
  type Tool,
} from '../lib/sketch'
import { unique, type useComposeFiles } from '../lib/uploads'
import { IconSketch } from './icons'
import { cx } from './ui'

// A simple shape drawing tool (plain SVG), opened from the compose boxes. The
// drawing becomes a PNG attachment; the scene stays on the file tile so it can
// be edited before the message is sent. The same modal draws on an attached image.

const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif'
const TOOLS: { tool: Tool; label: string; glyph: string }[] = [
  { tool: 'select', label: 'Select and move', glyph: '↖' },
  { tool: 'rect', label: 'Rectangle', glyph: '▭' },
  { tool: 'ellipse', label: 'Ellipse', glyph: '◯' },
  { tool: 'line', label: 'Line', glyph: '╱' },
  { tool: 'arrow', label: 'Arrow', glyph: '→' },
  { tool: 'text', label: 'Text', glyph: 'T' },
  { tool: 'pen', label: 'Pen', glyph: '✎' },
  { tool: 'eraser', label: 'Eraser', glyph: '⌫' },
]

type Paint = { stroke: string; strokeWidth: number; fill: string; fillOpacity?: number; pointerEvents?: 'all' | 'stroke' }

/** The geometry of one shape; the same for the visible shape and its hit area. */
function Geom({ s, paint, hit }: { s: Shape; paint: Paint; hit?: boolean }) {
  const common = { ...paint, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const noFill = { ...common, fill: 'none', pointerEvents: hit ? ('stroke' as const) : undefined }
  switch (s.kind) {
    case 'rect': {
      const b = normBox(s)
      return <rect x={b.x} y={b.y} width={b.w} height={b.h} {...common} />
    }
    case 'ellipse': {
      const b = normBox(s)
      return <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} {...common} />
    }
    case 'line':
      return <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...noFill} />
    case 'arrow': {
      const [a, c] = arrowHead(s.x1, s.y1, s.x2, s.y2, s.width)
      return (
        <>
          <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...noFill} />
          <polyline points={`${a[0]},${a[1]} ${s.x2},${s.y2} ${c[0]},${c[1]}`} {...noFill} />
        </>
      )
    }
    case 'pen':
      return <path d={pathOf(s.pts ?? [])} {...noFill} />
    case 'text':
      return (
        <text x={s.x1} y={s.y1} fontSize={textSize(s)} fontFamily={FONT} fill={hit ? 'transparent' : s.stroke} stroke="none" pointerEvents={hit ? 'all' : undefined}>
          {s.text}
        </text>
      )
  }
}

function ShapeEl({ s }: { s: Shape }) {
  const b = shapeBounds(s)
  const filled = s.fill && (s.kind === 'rect' || s.kind === 'ellipse')
  return (
    <g data-testid="sketch-shape" data-kind={s.kind} data-shape-id={s.id} data-x={Math.round(b.x)} data-y={Math.round(b.y)} data-w={Math.round(b.w)} data-h={Math.round(b.h)}>
      <Geom s={s} paint={{ stroke: s.stroke, strokeWidth: s.width, fill: filled ? s.stroke : 'none', fillOpacity: filled ? 0.25 : undefined }} />
    </g>
  )
}

function HitEl({ s }: { s: Shape }) {
  const filled = s.fill && (s.kind === 'rect' || s.kind === 'ellipse')
  return (
    <g data-hit={s.id}>
      <Geom hit s={s} paint={{ stroke: 'transparent', strokeWidth: Math.max(s.width, 14), fill: filled ? 'transparent' : 'none', pointerEvents: filled ? 'all' : 'stroke' }} />
    </g>
  )
}

type Hist = { shapes: Shape[]; past: Shape[][]; future: Shape[][] }
type Gesture =
  | { type: 'draw'; id: string; before: Shape[]; shift?: boolean }
  | { type: 'move'; id: string; start: [number, number]; orig: Shape; before: Shape[] }
  | { type: 'handle'; id: string; handle: string; before: Shape[] }
  | { type: 'erase'; before: Shape[] }
type Editing = { id: string; x: number; y: number; text: string; isNew: boolean; stroke: string; width: number }

let counter = 0
const newId = () => `s${Date.now().toString(36)}${counter++}`

function Btn({ children, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={cx('flex h-8 min-w-8 items-center justify-center rounded-md border border-line2 bg-raised px-2 text-[13px] text-fg hover:bg-sel disabled:opacity-40', className)}
    >
      {children}
    </button>
  )
}

export function SketchModal({ initial, onDone, onClose }: { initial: Scene | null; onDone: (scene: Scene, png: Blob) => void | Promise<void>; onClose: () => void }) {
  const { isPhone } = useApp()
  const bg = initial?.bg
  const [h, setH] = useState<Hist>({ shapes: initial?.shapes ?? [], past: [], future: [] })
  const [tool, setTool] = useState<Tool>('rect')
  const [stroke, setStroke] = useState(PALETTE[0])
  const [width, setWidth] = useState(WIDTHS[1])
  const [fill, setFill] = useState(false)
  const [selId, setSelId] = useState<string | null>(null)
  const [editing, setEditingState] = useState<Editing | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, tick] = useState(0)
  const svgRef = useRef<SVGSVGElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const gest = useRef<Gesture | null>(null)
  const editRef = useRef<Editing | null>(null)
  const hRef = useRef(h)
  hRef.current = h
  const setEditing = (e: Editing | null) => {
    editRef.current = e
    setEditingState(e)
  }

  const changed = h.past.length > 0
  const shapes = h.shapes
  const selected = shapes.find((s) => s.id === selId) ?? null

  useLayoutEffect(() => {
    tick((n) => n + 1)
    panelRef.current?.focus()
    const on = () => tick((n) => n + 1)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])

  const live = (fn: (s: Shape[]) => Shape[]) => setH((x) => ({ ...x, shapes: fn(x.shapes) }))
  const commit = useCallback((next: Shape[]) => setH((x) => ({ shapes: next, past: [...x.past, x.shapes], future: [] })), [])
  const undo = useCallback(() => setH((x) => (x.past.length ? { shapes: x.past[x.past.length - 1], past: x.past.slice(0, -1), future: [x.shapes, ...x.future] } : x)), [])
  const redo = useCallback(() => setH((x) => (x.future.length ? { shapes: x.future[0], past: [...x.past, x.shapes], future: x.future.slice(1) } : x)), [])

  const pt = (e: { clientX: number; clientY: number }): [number, number] => {
    const m = svgRef.current!.getScreenCTM()!.inverse()
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m)
    return [p.x, p.y]
  }

  const finishEdit = (save: boolean) => {
    const ed = editRef.current
    if (!ed) return
    setEditing(null)
    if (!save) return
    const t = ed.text.trim()
    const cur = hRef.current.shapes
    if (ed.isNew) {
      if (!t) return
      commit([...cur, { id: ed.id, kind: 'text', x1: ed.x, y1: ed.y, x2: ed.x, y2: ed.y, text: t, stroke: ed.stroke, width: ed.width, fill: false }])
      setSelId(ed.id)
    } else if (!t) {
      commit(cur.filter((s) => s.id !== ed.id))
      setSelId(null)
    } else commit(cur.map((s) => (s.id === ed.id ? { ...s, text: t } : s)))
  }

  const remove = (id: string) => {
    commit(hRef.current.shapes.filter((s) => s.id !== id))
    setSelId((v) => (v === id ? null : v))
  }

  const endGesture = () => {
    const g = gest.current
    gest.current = null
    if (!g) return
    if (g.type === 'draw') {
      const s = hRef.current.shapes.find((x) => x.id === g.id)
      const tiny = s && s.kind !== 'pen' && s.kind !== 'text' && Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 3
      if (tiny) {
        setH((x) => ({ ...x, shapes: g.before }))
        return
      }
      setSelId(g.id)
    }
    setH((x) => (x.shapes === g.before ? x : { ...x, past: [...x.past, g.before], future: [] }))
  }

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (editRef.current) finishEdit(true)
    const p = pt(e)
    const target = e.target as Element
    const handle = target.closest('[data-handle]')?.getAttribute('data-handle')
    const hitId = target.closest('[data-hit]')?.getAttribute('data-hit') ?? null
    const before = hRef.current.shapes
    svgRef.current!.setPointerCapture(e.pointerId)
    if (handle && selId) {
      gest.current = { type: 'handle', id: selId, handle, before }
      return
    }
    if (tool === 'eraser') {
      gest.current = { type: 'erase', before }
      if (hitId) live((ss) => ss.filter((s) => s.id !== hitId))
      return
    }
    if (tool === 'select') {
      setSelId(hitId)
      const orig = before.find((s) => s.id === hitId)
      if (orig) gest.current = { type: 'move', id: orig.id, start: p, orig, before }
      return
    }
    if (tool === 'text') {
      setSelId(null)
      setEditing({ id: newId(), x: p[0], y: p[1], text: '', isNew: true, stroke, width })
      e.preventDefault()
      return
    }
    const id = newId()
    const s: Shape = { id, kind: tool, x1: p[0], y1: p[1], x2: p[0], y2: p[1], stroke, width, fill, pts: tool === 'pen' ? [p] : undefined }
    gest.current = { type: 'draw', id, before }
    live((ss) => [...ss, s])
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gest.current
    if (!g) return
    const p = pt(e)
    if (g.type === 'erase') {
      const id = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-hit]')?.getAttribute('data-hit')
      if (id) live((ss) => ss.filter((s) => s.id !== id))
    } else if (g.type === 'move') {
      live((ss) => ss.map((s) => (s.id === g.id ? moveShape(g.orig, p[0] - g.start[0], p[1] - g.start[1]) : s)))
    } else if (g.type === 'draw') {
      live((ss) =>
        ss.map((s) => {
          if (s.id !== g.id) return s
          if (s.kind === 'pen') return { ...s, pts: [...(s.pts ?? []), p] }
          const [x, y] = e.shiftKey ? constrain(s.kind, s.x1, s.y1, p[0], p[1]) : p
          return { ...s, x2: x, y2: y }
        }),
      )
    } else if (g.type === 'handle') {
      live((ss) =>
        ss.map((s) => {
          if (s.id !== g.id) return s
          // The handle moves one corner; the opposite one stays.
          const hx = g.handle === 'a' || g.handle === 'd' ? 'x1' : 'x2'
          const hy = g.handle === 'a' || g.handle === 'c' ? 'y1' : 'y2'
          const ax = hx === 'x1' ? s.x2 : s.x1
          const ay = hy === 'y1' ? s.y2 : s.y1
          const [x, y] = e.shiftKey ? constrain(s.kind, ax, ay, p[0], p[1]) : p
          return { ...s, [hx]: x, [hy]: y }
        }),
      )
    }
  }

  const onDouble = (e: React.MouseEvent) => {
    const id = (e.target as Element).closest('[data-hit]')?.getAttribute('data-hit')
    const s = shapes.find((x) => x.id === id)
    if (s?.kind === 'text') {
      setTool('select')
      setEditing({ id: s.id, x: s.x1, y: s.y1, text: s.text ?? '', isNew: false, stroke: s.stroke, width: s.width })
    }
  }

  const style = (patch: Partial<Pick<Shape, 'stroke' | 'width' | 'fill'>>) => {
    if (patch.stroke) setStroke(patch.stroke)
    if (patch.width) setWidth(patch.width)
    if (patch.fill !== undefined) setFill(patch.fill)
    if (selId && tool === 'select') commit(hRef.current.shapes.map((s) => (s.id === selId ? { ...s, ...patch } : s)))
  }

  const done = async () => {
    const svg = svgRef.current
    const g = svg?.querySelector<SVGGElement>('[data-shapes]')
    if (!svg || !g || shapes.length === 0 || busy) return
    setBusy(true)
    setError('')
    try {
      let x = 0
      let y = 0
      let w = 0
      let hh = 0
      if (bg) {
        w = bg.w
        hh = bg.h
      } else {
        const bb = g.getBBox()
        const pad = 24
        x = bb.x - pad
        y = bb.y - pad
        w = bb.width + pad * 2
        hh = bb.height + pad * 2
      }
      const body = new XMLSerializer().serializeToString(g)
      const markup =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${hh}" viewBox="${x} ${y} ${w} ${hh}">` +
        (bg ? `<image href="${bg.href}" x="0" y="0" width="${bg.w}" height="${bg.h}"/>` : `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="#ffffff"/>`) +
        body +
        '</svg>'
      const png = await rasterize(markup, w, hh, bg ? 1 : 2)
      await onDone({ shapes, bg }, png)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make the image')
      setBusy(false)
    }
  }

  const close = () => {
    if (changed && !confirming) setConfirming(true)
    else onClose()
  }

  // Keys: handled here, and kept from the app's own shortcuts.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e) => {
    const inField = (e.target as Element | null)?.closest('input, textarea') != null
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (editRef.current) finishEdit(false)
      else if (confirming) setConfirming(false)
      else close()
      return
    }
    if (inField) return
    e.stopPropagation()
    if (mod && e.key === 'Enter') {
      e.preventDefault()
      void done()
    } else if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      redo()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selId) {
      e.preventDefault()
      remove(selId)
    }
  }
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', f, true)
    return () => window.removeEventListener('keydown', f, true)
  }, [])

  const ctm = svgRef.current?.getScreenCTM()
  const scale = ctm?.a ?? 1
  const hb = selected ? shapeBounds(selected) : null
  const pad = 6 / scale
  const handles: [string, number, number][] = !selected
    ? []
    : selected.kind === 'rect' || selected.kind === 'ellipse'
      ? [
          ['a', selected.x1, selected.y1],
          ['b', selected.x2, selected.y2],
          ['c', selected.x2, selected.y1],
          ['d', selected.x1, selected.y2],
        ]
      : selected.kind === 'line' || selected.kind === 'arrow'
        ? [
            ['a', selected.x1, selected.y1],
            ['b', selected.x2, selected.y2],
          ]
        : []

  const cursor = tool === 'select' ? 'default' : tool === 'eraser' ? 'not-allowed' : 'crosshair'
  const sep = <span aria-hidden="true" className="mx-1 h-5 w-px bg-line2" />

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(5,5,7,0.6)]">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Draw a diagram"
        data-testid="sketch-modal"
        className={cx('flex flex-col gap-2 border border-linestrong bg-overlay p-2.5 text-fg shadow-pop outline-none', isPhone ? 'h-[100dvh] w-screen' : 'h-[90vh] w-[90vw] rounded-[14px]')}
      >
        <div className="flex flex-wrap items-center gap-1.5" data-testid="sketch-toolbar">
          {TOOLS.map((t) => (
            <Btn
              key={t.tool}
              aria-label={t.label}
              aria-pressed={tool === t.tool}
              title={t.label}
              data-testid={`sketch-tool-${t.tool}`}
              className={cx(tool === t.tool && 'border-accent bg-sel')}
              onClick={() => {
                if (editRef.current) finishEdit(true)
                setTool(t.tool)
              }}
            >
              {t.glyph}
            </Btn>
          ))}
          {sep}
          {PALETTE.map((c, i) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={stroke === c}
              data-testid={`sketch-color-${i}`}
              onClick={() => style({ stroke: c })}
              className={cx('h-6 w-6 rounded-full border-2 p-0', stroke === c ? 'border-accent' : 'border-line2')}
              style={{ background: c }}
            />
          ))}
          {sep}
          {WIDTHS.map((w, i) => (
            <Btn key={w} aria-label={['Thin', 'Medium', 'Thick'][i] + ' line'} aria-pressed={width === w} data-testid={`sketch-width-${i}`} className={cx(width === w && 'border-accent bg-sel')} onClick={() => style({ width: w })}>
              <span aria-hidden="true" className="block w-4 rounded bg-current" style={{ height: w }} />
            </Btn>
          ))}
          <Btn aria-label="Fill shapes" aria-pressed={fill} title="Fill rectangles and ellipses" data-testid="sketch-fill" className={cx(fill && 'border-accent bg-sel')} onClick={() => style({ fill: !fill })}>
            ■ Fill
          </Btn>
          {sep}
          <Btn aria-label="Undo" title="Undo" data-testid="sketch-undo" disabled={h.past.length === 0} onClick={undo}>
            ↶
          </Btn>
          <Btn aria-label="Redo" title="Redo" data-testid="sketch-redo" disabled={h.future.length === 0} onClick={redo}>
            ↷
          </Btn>
          <Btn aria-label="Delete selected" title="Delete selected" data-testid="sketch-delete" disabled={!selId} onClick={() => selId && remove(selId)}>
            Delete
          </Btn>
          <Btn aria-label="Clear" title="Clear all" data-testid="sketch-clear" disabled={shapes.length === 0} onClick={() => (commit([]), setSelId(null))}>
            Clear
          </Btn>
          <span className="flex-1" />
          {error && (
            <span role="alert" className="text-[12px] text-danger">
              {error}
            </span>
          )}
          <Btn aria-label="Cancel" data-testid="sketch-cancel" onClick={close}>
            Cancel
          </Btn>
          <Btn aria-label="Done" data-testid="sketch-done" disabled={shapes.length === 0 || busy} className="border-accent bg-accent font-semibold text-white hover:bg-accent" onClick={() => void done()}>
            {busy ? 'Saving…' : 'Done'}
          </Btn>
        </div>
        {confirming && (
          <div role="alert" data-testid="sketch-discard" className="flex items-center gap-2 rounded-md border border-wait/50 bg-raised px-3 py-1.5 text-[13px]">
            <span className="flex-1">Discard this drawing?</span>
            <Btn data-testid="sketch-keep" onClick={() => setConfirming(false)}>
              Keep drawing
            </Btn>
            <Btn data-testid="sketch-discard-yes" onClick={onClose}>
              Discard
            </Btn>
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line2 bg-white">
          <svg
            ref={svgRef}
            data-testid="sketch-canvas"
            className="block h-full w-full touch-none select-none"
            style={{ cursor }}
            viewBox={bg ? `0 0 ${bg.w} ${bg.h}` : undefined}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onDoubleClick={onDouble}
          >
            {bg && <image href={bg.href} x={0} y={0} width={bg.w} height={bg.h} data-testid="sketch-bg" />}
            <g data-shapes>
              {shapes.map((s) => (editing && editing.id === s.id ? null : <ShapeEl key={s.id} s={s} />))}
            </g>
            <g data-ui style={{ pointerEvents: tool === 'select' || tool === 'eraser' ? 'auto' : 'none' }}>
              {shapes.map((s) => (editing && editing.id === s.id ? null : <HitEl key={s.id} s={s} />))}
            </g>
            {selected && hb && tool === 'select' && !editing && (
              <g data-ui>
                <rect x={hb.x - pad} y={hb.y - pad} width={hb.w + pad * 2} height={hb.h + pad * 2} fill="none" stroke="#2563eb" strokeWidth={1 / scale} strokeDasharray={`${4 / scale} ${3 / scale}`} pointerEvents="none" />
                {handles.map(([k, x, y]) => (
                  <circle key={k} data-handle={k} data-testid="sketch-handle" cx={x} cy={y} r={6 / scale} fill="#fff" stroke="#2563eb" strokeWidth={1.5 / scale} style={{ cursor: 'move' }} />
                ))}
              </g>
            )}
          </svg>
          {editing && ctm && <TextInput ed={editing} ctm={ctm} onChange={(text) => setEditing({ ...editing, text })} onCommit={() => finishEdit(true)} onCancel={() => finishEdit(false)} host={svgRef.current!.parentElement!} />}
        </div>
        <div className="text-[12px] text-subtle">
          {bg ? 'Drawing on an image. ' : ''}Shift constrains lines to 45° and shapes to squares. Double-click text to edit. Delete removes the selection. {isPhone ? '' : '⌘/Ctrl+Enter is Done, Esc cancels.'}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The inline text box, placed over the canvas where the text will be. */
function TextInput({ ed, ctm, host, onChange, onCommit, onCancel }: { ed: Editing; ctm: DOMMatrix; host: HTMLElement; onChange: (t: string) => void; onCommit: () => void; onCancel: () => void }) {
  const size = textSize(ed) * ctm.a
  const r = host.getBoundingClientRect()
  const ref = useRef<HTMLInputElement>(null)
  // Focus after the pointer's own focus change, which would blur it at once.
  useEffect(() => {
    const t = setTimeout(() => ref.current?.focus(), 0)
    return () => clearTimeout(t)
  }, [])
  return (
    <input
      ref={ref}
      data-testid="sketch-text-input"
      aria-label="Text"
      value={ed.text}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      className="absolute m-0 border-0 border-b border-dashed border-[#2563eb] bg-transparent p-0 outline-none"
      style={{
        left: ctm.a * ed.x + ctm.e - r.left,
        top: ctm.d * ed.y + ctm.f - r.top - size * 0.85,
        width: Math.max(120, ed.text.length * size * 0.65 + 20),
        fontSize: size,
        fontFamily: FONT,
        lineHeight: 1.2,
        color: ed.stroke,
      }}
    />
  )
}

type Compose = ReturnType<typeof useComposeFiles>

/** The "Draw a diagram" button next to the paperclip, and the modal it opens. */
export function SketchButton({ compose, size = 16 }: { compose: Compose; size?: number }) {
  const [open, setOpen] = useState<{ scene: Scene | null; replace?: { key: string; name: string; annotate: boolean } } | null>(null)
  const filesRef = useRef(compose.files)
  filesRef.current = compose.files

  useEffect(
    () =>
      onSketchRequest(async ({ key, mode }) => {
        const f = filesRef.current.find((x) => x.key === key)
        if (!f) return
        if (mode === 'edit' && f.sketch) {
          setOpen({ scene: f.sketch, replace: { key, name: f.name, annotate: false } })
        } else if (mode === 'annotate' && f.preview) {
          try {
            const blob = await (await fetch(f.preview)).blob()
            const href = await blobToDataUrl(blob)
            const img = new Image()
            img.src = href
            await img.decode()
            const base = f.name.replace(/\.[^.]+$/, '')
            setOpen({ scene: { shapes: [], bg: { href, w: img.naturalWidth, h: img.naturalHeight } }, replace: { key, name: `${base}-annotated.png`, annotate: true } })
          } catch {
            /* the image could not be read: no annotation */
          }
        }
      }),
    [],
  )

  const onDone = (scene: Scene, png: Blob) => {
    const taken = new Set(filesRef.current.map((f) => f.name))
    if (open?.replace) taken.delete(open.replace.name)
    const name = open?.replace ? unique(open.replace.name, taken) : unique(sketchName(), taken)
    compose.add(png, name, { sketch: scene })
    if (open?.replace) compose.remove(open.replace.key)
    setOpen(null)
  }

  return (
    <>
      <button type="button" aria-label="Draw a diagram" title="Draw a diagram" data-testid="compose-draw" onClick={() => setOpen({ scene: null })} className="border-0 bg-transparent p-1 text-muted hover:text-fg">
        <IconSketch size={size} />
      </button>
      {open && <SketchModal initial={open.scene} onDone={onDone} onClose={() => setOpen(null)} />}
    </>
  )
}

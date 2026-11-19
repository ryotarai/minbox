// Pure helpers for the diagram sketcher (geometry, constraints, scene types).

export type Tool = 'select' | 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'pen' | 'eraser'
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'pen' | 'text'

export type Shape = {
  id: string
  kind: ShapeKind
  /** Corner/end points of rect, ellipse, line, arrow; the anchor (baseline start) of text. */
  x1: number
  y1: number
  x2: number
  y2: number
  /** Points of a freehand stroke. */
  pts?: [number, number][]
  text?: string
  stroke: string
  width: number
  /** The fill of a closed shape (rect, ellipse): a palette color, drawn as a light tint
   * (FILL_OPACITY). false: none. true: the stroke color (older sketches). Other kinds ignore it. */
  fill: string | boolean
}

/** What is kept in a compose file so a sketch can be opened again before sending. */
export type Scene = {
  shapes: Shape[]
  /** A raster image drawn on, kept untouched underneath (data URL; scene units = image pixels). */
  bg?: { href: string; w: number; h: number }
}

export const PALETTE = ['#111827', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#9333ea', '#ffffff']
export const WIDTHS = [2, 4, 7]
/** Fills are drawn as a tint of the color, so the outline and anything under it still read. */
export const FILL_OPACITY = 0.3

/** Whether a kind of shape is closed (has an inside that can be filled). */
export const isClosed = (kind: ShapeKind | Tool) => kind === 'rect' || kind === 'ellipse'

/** The color a shape is filled with, or null when it has no fill. */
export function fillOf(s: Pick<Shape, 'kind' | 'fill' | 'stroke'>): string | null {
  if (!isClosed(s.kind) || !s.fill) return null
  return s.fill === true ? s.stroke : s.fill
}
export const TEXT_BASE = 18

export const textSize = (s: Pick<Shape, 'width'>) => TEXT_BASE + s.width * 3
/** Line height of multi-line text, as a multiple of the font size. */
export const TEXT_LINE_HEIGHT = 1.25

/** The lines of a text shape (it may hold newlines). */
export const textLines = (text: string | undefined) => (text ?? '').split(/\r\n|\r|\n/)

/** Snaps the vector a->b to the nearest 45 degree step. */
export function snap45(ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax
  const dy = by - ay
  const len = Math.hypot(dx, dy)
  if (len === 0) return [bx, by]
  const step = Math.PI / 4
  const a = Math.round(Math.atan2(dy, dx) / step) * step
  return [ax + Math.cos(a) * len, ay + Math.sin(a) * len]
}

/** Makes the box a->b square (the longer side wins), keeping the signs of the drag. */
export function squareOf(ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax
  const dy = by - ay
  const m = Math.max(Math.abs(dx), Math.abs(dy))
  return [ax + (dx < 0 ? -m : m), ay + (dy < 0 ? -m : m)]
}

/** The dragged end of a shape under Shift. */
export function constrain(kind: ShapeKind, ax: number, ay: number, bx: number, by: number): [number, number] {
  if (kind === 'line' || kind === 'arrow') return snap45(ax, ay, bx, by)
  if (kind === 'rect' || kind === 'ellipse') return squareOf(ax, ay, bx, by)
  return [bx, by]
}

export function normBox(s: Shape) {
  return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) }
}

/** The arrowhead as two wing points for a line a->b. */
export function arrowHead(ax: number, ay: number, bx: number, by: number, width: number): [number, number][] {
  const a = Math.atan2(by - ay, bx - ax)
  const len = 9 + width * 2.5
  const spread = Math.PI / 7
  return [-1, 1].map((sgn) => [bx - Math.cos(a + sgn * spread) * len, by - Math.sin(a + sgn * spread) * len] as [number, number])
}

export function moveShape(s: Shape, dx: number, dy: number): Shape {
  return { ...s, x1: s.x1 + dx, y1: s.y1 + dy, x2: s.x2 + dx, y2: s.y2 + dy, pts: s.pts?.map(([x, y]) => [x + dx, y + dy] as [number, number]) }
}

export const textSizeOf = (s: Pick<Shape, 'width'>) => textSize(s)

/** An estimate of a line's width in ems: wide (CJK, full-width) characters count 1, others 0.6. */
export function textEms(line: string): number {
  let n = 0
  for (const ch of line) n += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]/u.test(ch) ? 1 : 0.6
  return n
}

/** An estimate of the bounds (text width is approximated). */
export function shapeBounds(s: Shape) {
  if (s.kind === 'pen' && s.pts?.length) {
    const xs = s.pts.map((p) => p[0])
    const ys = s.pts.map((p) => p[1])
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  if (s.kind === 'text') {
    const size = textSize(s)
    const lines = textLines(s.text)
    const longest = Math.max(...lines.map(textEms))
    return { x: s.x1, y: s.y1 - size, w: Math.max(size, longest * size), h: size * 1.25 + (lines.length - 1) * size * TEXT_LINE_HEIGHT }
  }
  return normBox(s)
}

// Hit-testing: which shape a press at a point picks. Tolerances are in screen pixels
// (divided by the canvas scale), so picking feels the same at any zoom and stroke width.

/** Screen-pixel tolerance around strokes: a mouse is precise, a finger is not. */
export const hitTolerance = (pointerType: string) => (pointerType === 'touch' ? 16 : 8)

/** How a point hits a shape, best first: its ink (stroke, outline, text box), inside the box
 * of a selected shape, or inside a closed shape (filled or not). */
export type HitKind = 'ink' | 'selected' | 'inside'
export type Hit = { id: string; kind: HitKind; area: number; z: number }

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function distToPolyline(px: number, py: number, pts: [number, number][]): number {
  if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1])
  let d = Infinity
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSeg(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]))
  return d
}

/** The distance from a point to a shape's drawn line (Infinity for text), and whether the point is inside it. */
export function shapeDistance(s: Shape, px: number, py: number): { d: number; inside: boolean } {
  switch (s.kind) {
    case 'pen':
      return { d: s.pts?.length ? distToPolyline(px, py, s.pts) : Infinity, inside: false }
    case 'line':
      return { d: distToSeg(px, py, s.x1, s.y1, s.x2, s.y2), inside: false }
    case 'arrow': {
      const [a, c] = arrowHead(s.x1, s.y1, s.x2, s.y2, s.width)
      return { d: Math.min(distToSeg(px, py, s.x1, s.y1, s.x2, s.y2), distToPolyline(px, py, [a, [s.x2, s.y2], c])), inside: false }
    }
    case 'rect': {
      const b = normBox(s)
      const c: [number, number][] = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h], [b.x, b.y]]
      return { d: distToPolyline(px, py, c), inside: px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h }
    }
    case 'ellipse': {
      const b = normBox(s)
      const rx = b.w / 2
      const ry = b.h / 2
      const cx = b.x + rx
      const cy = b.y + ry
      // A flat ellipse is a line.
      if (rx < 0.5 || ry < 0.5) return { d: distToSeg(px, py, b.x, b.y, b.x + b.w, b.y + b.h), inside: false }
      const dx = px - cx
      const dy = py - cy
      const k = Math.hypot(dx / rx, dy / ry)
      const r = Math.hypot(dx, dy)
      // Radial distance to the outline: close to the true distance, exact on the axes.
      const d = k === 0 ? Math.min(rx, ry) : r * Math.abs(1 - 1 / k)
      return { d, inside: k <= 1 }
    }
    case 'text':
      return { d: Infinity, inside: false }
  }
}

/** Every shape at a point, with how it is hit. `tol` is in scene units. */
export function hitsAt(shapes: Shape[], p: [number, number], tol: number, opts: { selected?: string[]; inside?: boolean } = {}): Hit[] {
  const out: Hit[] = []
  shapes.forEach((s, z) => {
    const b = shapeBounds(s)
    const area = Math.max(1, b.w * b.h)
    const inBox = (pad: number) => p[0] >= b.x - pad && p[0] <= b.x + b.w + pad && p[1] >= b.y - pad && p[1] <= b.y + b.h + pad
    // Cheap reject: far outside the box (plus stroke and tolerance) is no hit at all.
    if (!inBox(tol + s.width)) return
    if (s.kind === 'text') {
      if (inBox(tol / 2)) out.push({ id: s.id, kind: 'ink', area, z })
      return
    }
    const { d, inside } = shapeDistance(s, p[0], p[1])
    if (d <= s.width / 2 + tol) out.push({ id: s.id, kind: 'ink', area, z })
    else if (opts.selected?.includes(s.id) && inBox(tol / 2)) out.push({ id: s.id, kind: 'selected', area, z })
    else if (inside && (opts.inside !== false || fillOf(s) != null)) out.push({ id: s.id, kind: 'inside', area, z })
  })
  return out
}

const RANK: Record<HitKind, number> = { ink: 0, selected: 1, inside: 2 }

/** The best hit: ink beats a selected shape's box, which beats the inside of a shape. Among
 * ink and selected hits the topmost (last drawn) wins; among insides the smallest, so a shape
 * drawn inside a big rectangle stays pickable. */
export function bestHit(hits: Hit[]): Hit | null {
  let best: Hit | null = null
  for (const h of hits) {
    if (!best) best = h
    else if (RANK[h.kind] !== RANK[best.kind]) {
      if (RANK[h.kind] < RANK[best.kind]) best = h
    } else if (h.kind === 'inside' ? h.area < best.area || (h.area === best.area && h.z > best.z) : h.z > best.z) best = h
  }
  return best
}

/** The shape a press at `point` (scene units) picks, or null. `tolerancePx` is in screen pixels,
 * `scale` the screen pixels per scene unit. With `selected`, a press anywhere in the box of a
 * selected shape keeps it; `inside: false` skips the inside of unfilled shapes (the eraser). */
export function hitTest(shapes: Shape[], point: [number, number], tolerancePx: number, scale: number, opts: { selected?: string[]; inside?: boolean } = {}): string | null {
  return bestHit(hitsAt(shapes, point, tolerancePx / (scale || 1), opts))?.id ?? null
}

export function pathOf(pts: [number, number][]): string {
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]}l0.01 0`
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`).join('')
}

export function sketchName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `sketch-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`
}

export const isRasterName = (name: string) => /\.(png|jpe?g|webp|gif)$/i.test(name)

/** Draws the serialized SVG into a canvas at the given scale; answers a PNG. */
export async function rasterize(svg: string, w: number, h: number, scale: number): Promise<Blob> {
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const k = Math.min(scale, 8192 / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w * k))
  c.height = Math.max(1, Math.round(h * k))
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not make the image'))), 'image/png'))
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })
}

/** A request from a file tile to open the sketcher on that file. */
export type SketchRequest = { key: string; mode: 'edit' | 'annotate' }
const listeners = new Set<(r: SketchRequest) => void>()
export const onSketchRequest = (f: (r: SketchRequest) => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}
export const requestSketch = (r: SketchRequest) => listeners.forEach((l) => l(r))

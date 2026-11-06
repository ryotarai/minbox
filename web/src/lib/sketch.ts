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
  fill: boolean
}

/** What is kept in a compose file so a sketch can be opened again before sending. */
export type Scene = {
  shapes: Shape[]
  /** A raster image drawn on, kept untouched underneath (data URL; scene units = image pixels). */
  bg?: { href: string; w: number; h: number }
}

export const PALETTE = ['#111827', '#dc2626', '#ea580c', '#16a34a', '#2563eb', '#9333ea', '#ffffff']
export const WIDTHS = [2, 4, 7]
export const TEXT_BASE = 18

export const textSize = (s: Pick<Shape, 'width'>) => TEXT_BASE + s.width * 3

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
    return { x: s.x1, y: s.y1 - size, w: Math.max(size, (s.text ?? '').length * size * 0.6), h: size * 1.25 }
  }
  return normBox(s)
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

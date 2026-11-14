export type Box = { left: number; right: number; top: number; bottom: number }
export type VisibleArea = { left: number; top: number; width: number; height: number }

/**
 * Where to put a popover so it stays inside the visible area (the visual viewport: it shrinks when an
 * on-screen keyboard opens, while the layout viewport does not). Pure: all inputs in the same
 * (unzoomed, layout viewport) coordinates. `maxHeight` is the room on the chosen side; the popover scrolls inside it.
 */
export function placePopover(o: {
  anchor: Box
  width: number
  height: number
  vv: VisibleArea
  side: 'bottom' | 'top' | 'right'
  align: 'start' | 'end'
}): { left: number; top: number; maxHeight: number } {
  const m = 8
  const gap = 4
  const { anchor: a, width: w, height: h, vv, side, align } = o
  const vTop = vv.top
  const vBottom = vv.top + vv.height
  const full = Math.max(80, vv.height - 2 * m)
  let left = side === 'right' ? a.right + gap : align === 'end' ? a.right - w : a.left
  left = Math.min(Math.max(vv.left + m, left), vv.left + vv.width - w - m)
  let top: number
  let maxHeight: number
  if (side === 'right') {
    maxHeight = full
    top = Math.min(a.top, vBottom - m - Math.min(h, full))
    top = Math.max(vTop + m, top)
  } else {
    const below = vBottom - m - (a.bottom + gap)
    const above = a.top - gap - (vTop + m)
    const preferBelow = side === 'bottom'
    const fits = preferBelow ? h <= below : h <= above
    const useBelow = fits ? preferBelow : below >= above
    const room = Math.max(80, useBelow ? below : above)
    maxHeight = Math.min(room, full)
    const used = Math.min(h, maxHeight)
    top = useBelow ? a.bottom + gap : a.top - gap - used
    top = Math.min(Math.max(vTop + m, top), vBottom - m - used)
  }
  return { left, top, maxHeight }
}

/** A touch-first device: focusing a field there opens the on-screen keyboard, so do not autofocus. */
export function coarsePointer(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
}

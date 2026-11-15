import { useEffect, useRef } from 'react'
import type { PointerEvent as RPointerEvent, MouseEvent as RMouseEvent, CSSProperties } from 'react'

const HOLD_MS = 500
const SLOP = 10

/** Where a long press happened: the pointer position (viewport px) and the element holding the handlers. */
export type LongPressPoint = { x: number; y: number; el: HTMLElement }

export type LongPressOptions = {
  /** Only these pointer types start a hold (default: all, mouse included). */
  pointerTypes?: readonly string[]
  /** Also fire on a right-click / the context-menu key (default true). */
  contextMenu?: boolean
}

/**
 * Props for an element that does something else on a long press (touch or mouse hold, ~500 ms),
 * and by default on a right-click or the context-menu key. The click that follows a long press is
 * swallowed, so the element's normal action does not run. Moving, scrolling or releasing early
 * cancels it.
 */
export function useLongPress(onLongPress: (p: LongPressPoint) => void, opts: LongPressOptions = {}) {
  const cb = useRef(onLongPress)
  cb.current = onLongPress
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const start = useRef<LongPressPoint>({ x: 0, y: 0, el: null as unknown as HTMLElement })
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])
  const pressing = useRef(false)
  const fire = (p: LongPressPoint) => {
    clear()
    if (fired.current) return
    fired.current = true
    try {
      navigator.vibrate?.(10)
    } catch {
      /* not allowed */
    }
    cb.current(p)
    // The click that ends the press arrives right after it is released (a held press: see release);
    // afterwards the flag is stale.
    if (!pressing.current) setTimeout(() => (fired.current = false), 400)
  }
  const release = () => {
    clear()
    if (pressing.current && fired.current) setTimeout(() => (fired.current = false), 400)
    pressing.current = false
  }
  const style: CSSProperties = { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }
  const contextMenu = opts.contextMenu !== false
  const types = opts.pointerTypes
  return {
    style,
    onPointerDown: (e: RPointerEvent) => {
      if (e.button !== 0) return
      if (types && !types.includes(e.pointerType)) return
      fired.current = false
      pressing.current = true
      start.current = { x: e.clientX, y: e.clientY, el: e.currentTarget as HTMLElement }
      clear()
      timer.current = setTimeout(() => fire(start.current), HOLD_MS)
    },
    onPointerMove: (e: RPointerEvent) => {
      if (timer.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP) clear()
    },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: release,
    ...(contextMenu
      ? {
          onContextMenu: (e: RMouseEvent) => {
            e.preventDefault()
            fire({ x: e.clientX, y: e.clientY, el: e.currentTarget as HTMLElement })
          },
        }
      : {}),
    onClickCapture: (e: RMouseEvent) => {
      if (fired.current) {
        e.preventDefault()
        e.stopPropagation()
        fired.current = false
      }
    },
  }
}

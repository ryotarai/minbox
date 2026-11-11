import { useEffect, useRef } from 'react'
import type { PointerEvent as RPointerEvent, MouseEvent as RMouseEvent, CSSProperties } from 'react'

const HOLD_MS = 500
const SLOP = 10

/**
 * Props for a button that does something else on a long press (touch or mouse hold, ~500 ms),
 * on a right-click, or on the context-menu key. The click that follows a long press is swallowed,
 * so the button's normal action does not run. Moving, scrolling or releasing early cancels it.
 */
export function useLongPress(onLongPress: () => void) {
  const cb = useRef(onLongPress)
  cb.current = onLongPress
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const start = useRef({ x: 0, y: 0 })
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])
  const fire = () => {
    clear()
    if (fired.current) return
    fired.current = true
    try {
      navigator.vibrate?.(10)
    } catch {
      /* not allowed */
    }
    cb.current()
    // The click that ends the press arrives right after; afterwards the flag is stale.
    setTimeout(() => (fired.current = false), 400)
  }
  const style: CSSProperties = { WebkitTouchCallout: 'none', WebkitUserSelect: 'none', userSelect: 'none' }
  return {
    style,
    onPointerDown: (e: RPointerEvent) => {
      if (e.button !== 0) return
      fired.current = false
      start.current = { x: e.clientX, y: e.clientY }
      clear()
      timer.current = setTimeout(fire, HOLD_MS)
    },
    onPointerMove: (e: RPointerEvent) => {
      if (timer.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > SLOP) clear()
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: RMouseEvent) => {
      e.preventDefault()
      fire()
    },
    onClickCapture: (e: RMouseEvent) => {
      if (fired.current) {
        e.preventDefault()
        e.stopPropagation()
        fired.current = false
      }
    },
  }
}

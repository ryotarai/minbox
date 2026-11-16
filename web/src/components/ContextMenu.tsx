import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { isTyping } from '../lib/hotkeys'
import { useLongPress } from '../lib/useLongPress'
import { Popover, type MenuAt } from './ui'

// Right-click menus. An item gets one with `useContextMenu()`: spread `props` on it and render the
// menu (a <ContextMenu>, or any menu that passes `at` on to its <Popover>) while `at` is set.
//   - right-click opens it at the pointer; Shift+F10 / the context-menu key opens it under the item;
//   - on touch a long press (~500 ms) opens it at the finger; moving or scrolling cancels the press,
//     and the tap that ends the press does not also open the item;
//   - fields, links, the terminal and selected text keep the browser's own menu.

/** Where the browser's own menu is the better one: fields, links, the terminal. */
function nativeTarget(target: EventTarget): boolean {
  return !!(target as Element).closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], a[href], .xterm, [data-native-menu]')
}

/** Text is selected inside the item (the browser's menu has Copy for it). */
function hasSelection(item: Element): boolean {
  const sel = window.getSelection()
  return !!sel && !sel.isCollapsed && !!sel.toString().trim() && !!sel.anchorNode && item.contains(sel.anchorNode)
}

export function useContextMenu({ longPress = true }: { longPress?: boolean } = {}) {
  const [at, setAt] = useState<MenuAt | null>(null)
  const close = useCallback(() => setAt(null), [])
  const byKey = useRef(0)
  // The selection as it was when the right button went down: on macOS the press itself selects the word under it.
  const selAtDown = useRef<{ t: number; sel: boolean } | null>(null)
  const lp = useLongPress((p) => setAt(p), { pointerTypes: ['touch', 'pen'], contextMenu: false })
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    // An element inside the item opened its own menu already.
    if (e.defaultPrevented || nativeTarget(e.target)) return
    const down = selAtDown.current
    selAtDown.current = null
    if (down && Date.now() - down.t < 2000 ? down.sel : hasSelection(e.currentTarget)) return
    e.preventDefault()
    // The key that opened it may also send a contextmenu event (Windows): one menu, under the item.
    if (Date.now() - byKey.current < 500) return
    const el = e.currentTarget
    // From the keyboard there is no pointer position: under the item.
    if (e.button !== 2 && e.clientX === 0 && e.clientY === 0) setAt({ el })
    else setAt({ el, x: e.clientX, y: e.clientY })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return
    if (e.defaultPrevented || isTyping(e.target)) return
    e.preventDefault()
    byKey.current = Date.now()
    setAt({ el: e.currentTarget })
  }
  const props = {
    'aria-haspopup': 'menu' as const,
    onContextMenu,
    onKeyDown,
    onMouseDownCapture: (e: MouseEvent<HTMLElement>) => {
      if (e.button === 2) selAtDown.current = { t: Date.now(), sel: hasSelection(e.currentTarget) }
    },
    ...(longPress
      ? {
          style: lp.style,
          onPointerDown: lp.onPointerDown,
          onPointerMove: lp.onPointerMove,
          onPointerUp: lp.onPointerUp,
          onPointerCancel: lp.onPointerCancel,
          onPointerLeave: lp.onPointerLeave,
          onClickCapture: lp.onClickCapture,
        }
      : {}),
  }
  // open: from a "…" button of the item (under the button).
  return { at, close, open: setAt, props }
}

/** A context menu at `at` (from useContextMenu); children are MenuItems that close it themselves. */
export function ContextMenu({ at, onClose, children, className, testid = 'context-menu' }: { at: MenuAt | null; onClose: () => void; children: ReactNode; className?: string; testid?: string }) {
  return (
    <Popover anchor={null} at={at} open={!!at} onClose={onClose} className={className} testid={testid}>
      {children}
    </Popover>
  )
}

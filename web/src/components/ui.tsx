import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placePopover } from '../lib/popoverPlacement'
import { THREAD_STATUS_LABEL, type ThreadStatus } from '../api'

export function cx(...v: (string | false | null | undefined)[]): string {
  return v.filter(Boolean).join(' ')
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { ref?: React.Ref<HTMLButtonElement>; variant?: 'primary' | 'outline' | 'ghost' | 'danger' | 'quiet'; size?: 'sm' | 'md' | 'lg' }

/** Buttons: primary (amber), outline, ghost, danger. */
export function Button({ variant = 'outline', size = 'md', className, ...rest }: BtnProps) {
  const h = size === 'sm' ? 'h-[30px] px-2.5 text-[12.5px]' : size === 'lg' ? 'h-10 px-4 text-[14px]' : 'h-9 px-3.5 text-[13px]'
  const v = {
    primary: 'bg-accent text-onaccent font-[650] hover:brightness-110 border-0',
    outline: 'border border-linestrong bg-transparent hover:bg-raised',
    ghost: 'border-0 bg-transparent text-fg2 hover:bg-raised',
    quiet: 'border-0 bg-transparent text-muted hover:text-fg hover:bg-raised',
    danger: 'bg-dangerstrong text-white font-[650] border-0 hover:brightness-110',
  }[variant]
  return (
    <button
      type="button"
      className={cx('inline-flex shrink-0 items-center justify-center gap-2 rounded-md whitespace-nowrap disabled:opacity-45', h, v, className)}
      {...rest}
    />
  )
}

export function IconButton({ className, size = 32, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { size?: number }) {
  return (
    <button
      type="button"
      style={{ width: size, height: size }}
      className={cx('inline-flex shrink-0 items-center justify-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-raised hover:text-fg', className)}
      {...rest}
    />
  )
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx('rounded border border-linestrong px-1 text-[10.5px] leading-4 text-subtle', className)}>{children}</kbd>
}

/** A session that has ended (and can be resumed): plain muted label. */
export function EndedTag({ className }: { className?: string }) {
  return (
    <span data-testid="session-ended" className={cx('shrink-0 text-[12px] text-subtle', className)}>
      Ended
    </span>
  )
}

const THREAD_STATUS_STYLE: Record<ThreadStatus, { text: string; bg: string }> = {
  need_action: { text: 'text-wait', bg: 'bg-wait/12' },
  working: { text: 'text-work', bg: 'bg-work/12' },
  blocked: { text: 'text-muted', bg: 'bg-chip' },
  finished: { text: 'text-subtle', bg: 'bg-chip' },
}

/** A thread's status: pulsing dot while working, amber when it needs action, a muted check when finished. */
export function ThreadStatusBadge({ status, className, testid = 'thread-status' }: { status: ThreadStatus; className?: string; testid?: string }) {
  const st = THREAD_STATUS_STYLE[status] ?? THREAD_STATUS_STYLE.finished
  return (
    <span
      data-testid={testid}
      data-status={status}
      title={`Status: ${THREAD_STATUS_LABEL[status]}`}
      className={cx('inline-flex h-[18px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-[11px] font-semibold', st.bg, st.text, className)}
    >
      {status === 'finished' ? (
        <span aria-hidden="true">✓</span>
      ) : (
        <span aria-hidden="true" className={cx('inline-block h-[6px] w-[6px] rounded-full', status === 'working' ? 'mb-pulse bg-work' : status === 'blocked' ? 'bg-muted' : 'bg-wait')} />
      )}
      {THREAD_STATUS_LABEL[status]}
    </span>
  )
}

/** A popover menu anchored to an element; closes on outside click or Esc. */
/** Swallow the click that follows a mousedown on `anchor`; give up after 300 ms (no click came). */
function swallowNextClick(anchor: HTMLElement) {
  const stop = (e: MouseEvent) => {
    if (!anchor.contains(e.target as Node)) return
    e.stopPropagation()
    e.preventDefault()
    off()
  }
  const off = () => {
    clearTimeout(timer)
    document.removeEventListener('click', stop, true)
  }
  const timer = setTimeout(off, 300)
  document.addEventListener('click', stop, true)
}

/** A context menu's position: at the pointer (x/y, viewport px), or under `el` when opened from the keyboard. */
export type MenuAt = { el: HTMLElement; x?: number; y?: number }

/** The context menu open now: opening another closes it (only one at a time). */
let openContext: { close: () => void } | null = null

/** A finger is on the screen (a context menu opened now came from a touch hold). */
let fingerDown = false
if (typeof window !== 'undefined') {
  const set = (e: TouchEvent) => (fingerDown = e.touches.length > 0)
  window.addEventListener('touchstart', set, { capture: true, passive: true })
  window.addEventListener('touchend', set, { capture: true, passive: true })
  window.addEventListener('touchcancel', set, { capture: true, passive: true })
}

const ITEM_SEL = '[role="menuitem"]:not(:disabled),[role="menuitemcheckbox"]:not(:disabled),[role="menuitemradio"]:not(:disabled)'

/**
 * A popover menu anchored to an element; closes on outside click or Esc. With `at` it is a context
 * menu: placed at the pointer (flipped and clamped inside the visual viewport), focus moves to its
 * first item, and it also closes on scroll, resize and window blur; Esc gives focus back to `at.el`.
 */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'end',
  className,
  side = 'bottom',
  at,
  testid,
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  className?: string
  /** Open as a context menu (see above); `anchor` is then ignored. */
  at?: MenuAt | null
  testid?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  if (at) anchor = at.el
  const ctx = !!at
  const atX = at?.x
  const atY = at?.y
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const el = ref.current
      const w = el?.offsetWidth ?? 200
      const zoom = parseFloat((document.getElementById('root') as HTMLElement).style.zoom || '1')
      const v = window.visualViewport
      const vv = v
        ? { left: v.offsetLeft / zoom, top: v.offsetTop / zoom, width: v.width / zoom, height: v.height / zoom }
        : { left: 0, top: 0, width: window.innerWidth / zoom, height: window.innerHeight / zoom }
      const h = Math.max(el?.offsetHeight ?? 200, el?.scrollHeight ?? 0)
      if (ctx && atX !== undefined && atY !== undefined) {
        // At the pointer: below-right of it, flipped left / above when it does not fit.
        const x = atX / zoom
        const y = atY / zoom
        const flipX = x + w + 8 > vv.left + vv.width
        setPos(placePopover({ anchor: { left: x, right: x, top: y, bottom: y }, width: w, height: h, vv, side: 'bottom', align: flipX ? 'end' : 'start', gap: 0 }))
        return
      }
      const r = anchor.getBoundingClientRect()
      const ar = { left: r.left / zoom, right: r.right / zoom, top: r.top / zoom, bottom: r.bottom / zoom }
      setPos(placePopover({ anchor: ar, width: w, height: h, vv, side: ctx ? 'bottom' : side, align: ctx ? 'start' : align }))
    }
    place()
    const raf = requestAnimationFrame(place)
    // The on-screen keyboard shrinks the visual viewport (not the layout one): re-place on resize/scroll.
    const vvp = window.visualViewport
    vvp?.addEventListener('resize', place)
    vvp?.addEventListener('scroll', place)
    return () => {
      cancelAnimationFrame(raf)
      vvp?.removeEventListener('resize', place)
      vvp?.removeEventListener('scroll', place)
    }
  }, [open, anchor, align, side, ctx, atX, atY])
  // Context menu: one at a time, focus on the first item, close on scroll / resize / blur.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const openedAt = useRef(0)
  // Opened by a touch hold: when that finger lifts, the browser may send a mouse press and click on the item.
  const releasedAt = useRef(0)
  useEffect(() => {
    if (!open) return
    openedAt.current = Date.now()
    releasedAt.current = 0
    if (!ctx || !fingerDown) return
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length > 0) return
      releasedAt.current = Date.now()
      window.removeEventListener('touchend', onEnd, true)
    }
    window.addEventListener('touchend', onEnd, true)
    return () => window.removeEventListener('touchend', onEnd, true)
  }, [open, ctx, atX, atY])
  useEffect(() => {
    if (!open || !ctx) return
    const onClose = () => closeRef.current()
    const me = { close: onClose }
    if (openContext && openContext !== me) openContext.close()
    openContext = me
    const onScroll = (e: Event) => {
      const t = e.target as Element | null
      if (t instanceof Element && (ref.current?.contains(t) || t.closest('[role="menu"]'))) return
      onClose()
    }
    const onResize = () => {
      // An input in a menu (the snooze time picker) may open the on-screen keyboard: not a reason to close.
      if ((document.activeElement as Element | null)?.closest?.('[role="menu"]') && document.activeElement instanceof HTMLInputElement) return
      onClose()
    }
    const onBlur = () => onClose()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onBlur)
    return () => {
      if (openContext === me) openContext = null
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, ctx])
  // Focus moves to the first item at once (a key pressed right after the menu opens acts in it).
  const focusBack = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!open || !ctx || !anchor) return
    // Where focus goes back to: the element focused when it opened (a button inside the item, from
    // the keyboard), else the item.
    const prev = document.activeElement
    focusBack.current = prev instanceof HTMLElement && prev !== anchor && anchor.contains(prev) ? prev : anchor
    ref.current?.querySelector<HTMLElement>(ITEM_SEL)?.focus({ preventScroll: true })
  }, [open, ctx, anchor])
  // A context menu closed while focus was in it (now gone): focus goes back to the element it was opened on.
  useEffect(() => {
    if (!open || !ctx || !anchor) return
    const back = focusBack.current ?? anchor
    return () => {
      const a = document.activeElement
      if ((!a || a === document.body) && back.isConnected) back.focus({ preventScroll: true })
    }
  }, [open, ctx, anchor])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      // A submenu (another popover) is not outside.
      if (anchor?.contains(t)) {
        // The press that opened a context menu (a touch hold), and the mouse events the browser makes
        // when that finger lifts, are not a reason to close it, nor to open the item.
        if (ctx && (Date.now() - openedAt.current < 400 || Date.now() - releasedAt.current < 600)) {
          if (Date.now() - releasedAt.current < 600) {
            e.preventDefault() // focus stays in the menu
            swallowNextClick(anchor)
          }
          return
        }
        // Pressing the button that opened the menu closes it, and the click that follows must not
        // run the button's own onClick (it would open the menu again).
        swallowNextClick(anchor)
        onClose()
        return
      }
      if (ref.current?.contains(t) || t.closest?.('[role="menu"]')) return
      onClose()
    }
    // Keyboard activation (Enter/Space) clicks the anchor without a mousedown: close, don't re-open.
    const onClick = (e: MouseEvent) => {
      if (!anchor?.contains(e.target as Node)) return
      e.stopPropagation()
      e.preventDefault()
      // The click the browser makes when the finger of a touch hold lifts: the menu stays.
      if (ctx && Date.now() - releasedAt.current < 600) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor, ctx])
  if (!open) return null
  // Arrow keys, Home and End move between the items; Enter / Space activate the focused one.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (!ref.current?.contains(t) || !t.matches?.(ITEM_SEL)) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(ITEM_SEL)]
    const i = items.indexOf(t)
    let next: HTMLElement | undefined
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length]
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length]
    else if (e.key === 'Home') next = items[0]
    else if (e.key === 'End') next = items[items.length - 1]
    else if (e.key === 'Enter' || e.key === ' ') {
      // Handled here so the page's own Enter shortcut (open the thread) does not run as well.
      e.preventDefault()
      t.click()
      return
    } else if (ctx && e.key === 'Tab') {
      e.preventDefault()
      onClose()
      return
    } else if (ctx && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Single-key shortcuts of the page underneath must not run while the menu has focus.
      e.preventDefault()
      return
    } else return
    e.preventDefault()
    next?.focus()
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid={testid}
      data-context={ctx || undefined}
      onKeyDown={onKeyDown}
      onContextMenu={ctx ? (e) => e.preventDefault() : undefined}
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxHeight, overflowY: 'auto', overscrollBehavior: 'contain', zoom: (document.getElementById('root') as HTMLElement).style.zoom || undefined }}
      className={cx('z-[60] min-w-[190px] rounded-[10px] border border-linestrong bg-overlay p-[5px] text-[13px] shadow-pop', className)}
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuItem({
  children,
  onClick,
  danger,
  hint,
  testid,
  active,
  disabled,
}: {
  children: ReactNode
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  danger?: boolean
  hint?: ReactNode
  testid?: string
  active?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testid}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex h-8 w-full items-center justify-between gap-3 rounded-[6px] border-0 px-2.5 text-left hover:bg-sel disabled:opacity-40',
        active ? 'bg-sel' : 'bg-transparent',
        danger ? 'text-danger' : 'text-fg',
      )}
    >
      <span className="flex items-center gap-2">{children}</span>
      {hint && <span className="text-[11px] text-subtle">{hint}</span>}
    </button>
  )
}

export function MenuSep() {
  return <div aria-hidden="true" className="mx-0.5 my-1 h-px bg-line2" />
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-subtle">{children}</div>
}

/** A modal dialog with a dimmed backdrop. */
export function Modal({
  children,
  onClose,
  label,
  className,
  top,
  bottom,
}: {
  children: ReactNode
  onClose: () => void
  label: string
  className?: string
  top?: boolean
  /** A sheet at the bottom edge (phones). */
  bottom?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return createPortal(
    <div
      className={cx('fixed inset-0 z-50 flex justify-center bg-[rgba(5,5,7,0.6)]', bottom ? 'items-end p-0' : cx('p-4', top ? 'items-start pt-[10vh]' : 'items-center'))}
      style={{ zoom: (document.getElementById('root') as HTMLElement).style.zoom || undefined }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div role="dialog" aria-label={label} className={cx('rounded-[14px] border border-linestrong bg-overlay text-fg shadow-pop', className)}>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cx('relative h-6 w-10 shrink-0 rounded-full border-0 p-0', on ? 'bg-accent' : 'bg-linestrong')}
    >
      <span className={cx('absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white transition-[left]', on ? 'left-[19px]' : 'left-[3px]')} />
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  testidPrefix,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md' | 'lg'
  testidPrefix?: string
}) {
  const h = size === 'sm' ? 'h-[26px] text-[12.5px] px-2.5' : size === 'lg' ? 'h-[38px] text-[14px] flex-1' : 'h-[30px] text-[13px] px-3'
  return (
    <div role="radiogroup" className={cx('flex gap-0.5 rounded-[9px] bg-bg p-[3px]', size === 'lg' && 'w-full gap-1')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          data-testid={testidPrefix ? `${testidPrefix}-${o.value}` : undefined}
          onClick={() => onChange(o.value)}
          className={cx('rounded-[7px] border-0', h, o.value === value ? 'bg-sel font-[650] text-fg' : 'bg-transparent text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  const widths = [
    ['70%', '90%'],
    ['55%', '80%'],
    ['64%', '72%'],
  ]
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="mb-skeleton flex flex-col gap-1.5 py-1">
          <div className="h-3 rounded bg-sel" style={{ width: widths[i % 3]![0] }} />
          <div className="h-2.5 rounded bg-raised" style={{ width: widths[i % 3]![1] }} />
        </div>
      ))}
    </div>
  )
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('text-[11px] font-bold uppercase tracking-[0.06em] text-subtle', className)}>{children}</div>
}

/** Sets focus on mount. */
export function useAutoFocus<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return ref
}

/** The host a session runs on, as a small tag. */
/** Marks a session that runs a coding agent other than Claude Code (the default, so it is left unmarked). */
export function AgentTag({ agent, phone }: { agent?: string; phone?: boolean }) {
  if (!agent || agent === 'claude') return null
  return (
    <span
      title="Coding agent"
      data-testid="agent-tag"
      className={cx('mono shrink-0 whitespace-nowrap rounded border border-line2 px-[5px] text-subtle', phone ? 'text-[11px] leading-[17px]' : 'text-[10.5px] leading-4')}
    >
      {agent === 'pi' ? 'Pi' : agent === 'opencode' ? 'OpenCode' : agent}
    </span>
  )
}

export function HostTag({ name, phone }: { name?: string; phone?: boolean }) {
  if (!name) return null
  return (
    <span
      title="Host"
      data-testid="host-tag"
      className={cx('mono shrink-0 whitespace-nowrap rounded border border-line2 px-[5px] text-subtle', phone ? 'text-[11px] leading-[17px]' : 'text-[10.5px] leading-4')}
    >
      {name}
    </span>
  )
}

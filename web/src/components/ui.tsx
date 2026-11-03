import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Session } from '../api'

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

const STATUS = {
  wait: { label: 'Waiting for you', dot: 'bg-wait', text: 'text-wait', ring: 'shadow-[0_0_0_3px_color-mix(in_srgb,var(--mb-wait)_22%,transparent)]' },
  idle: { label: 'Waiting for you', dot: 'bg-fg2', text: 'text-muted', ring: '' },
  work: { label: 'Working', dot: 'bg-work', text: 'text-work', ring: 'shadow-[0_0_0_3px_color-mix(in_srgb,var(--mb-work)_18%,transparent)]' },
  start: { label: 'Starting', dot: 'border-[1.5px] border-muted', text: 'text-muted', ring: '' },
  shell: { label: 'Shell', dot: 'bg-fg2', text: 'text-muted', ring: '' },
  end: { label: 'Ended', dot: 'border-[1.5px] border-faint', text: 'text-subtle', ring: '' },
}

/** How a session's state shows: filled amber when it waits on the person. */
export function statusOf(s: Session, waitsOnPerson: boolean) {
  if (s.status === 'ended') return STATUS.end
  if (s.kind === 'shell') return STATUS.shell
  if (s.status === 'starting') return STATUS.start
  if (s.status === 'working') return STATUS.work
  return waitsOnPerson ? STATUS.wait : STATUS.idle
}

export function StatusDot({ s, waits, size = 8, ring = true }: { s: Session; waits: boolean; size?: number; ring?: boolean }) {
  const st = statusOf(s, waits)
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cx('inline-block shrink-0 rounded-full box-border', st.dot, ring && st.ring, s.status === 'working' && 'mb-pulse')}
    />
  )
}

export function StatusPill({ s, waits }: { s: Session; waits: boolean }) {
  const st = statusOf(s, waits)
  const bg = waits && s.status === 'idle' ? 'bg-wait/12' : s.status === 'working' ? 'bg-work/12' : 'bg-chip'
  return (
    <span className={cx('inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-semibold', bg, st.text)}>
      <StatusDot s={s} waits={waits} size={6} ring={false} />
      {st.label}
    </span>
  )
}

/** A popover menu anchored to an element; closes on outside click or Esc. */
export function Popover({
  anchor,
  open,
  onClose,
  children,
  align = 'end',
  className,
  side = 'bottom',
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
  children: ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top' | 'right'
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const el = ref.current
      const w = el?.offsetWidth ?? 200
      const h = el?.offsetHeight ?? 200
      const zoom = parseFloat((document.getElementById('root') as HTMLElement).style.zoom || '1')
      const vw = window.innerWidth / zoom
      const vh = window.innerHeight / zoom
      const ar = { left: r.left / zoom, right: r.right / zoom, top: r.top / zoom, bottom: r.bottom / zoom }
      let left = side === 'right' ? ar.right + 4 : align === 'end' ? ar.right - w : ar.left
      let top = side === 'top' ? ar.top - h - 4 : side === 'right' ? ar.top : ar.bottom + 4
      if (top + h > vh - 8) top = Math.max(8, ar.top - h - 4)
      left = Math.min(Math.max(8, left), vw - w - 8)
      setPos({ left, top })
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  }, [open, anchor, align, side])
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element
      // A submenu (another popover) is not outside.
      if (ref.current?.contains(t) || anchor?.contains(t) || t.closest?.('[role="menu"]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose, anchor])
  if (!open) return null
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, zoom: (document.getElementById('root') as HTMLElement).style.zoom || undefined }}
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
  onClick: () => void
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
}: {
  children: ReactNode
  onClose: () => void
  label: string
  className?: string
  top?: boolean
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
      className={cx('fixed inset-0 z-50 flex justify-center bg-[rgba(5,5,7,0.6)] p-4', top ? 'items-start pt-[10vh]' : 'items-center')}
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

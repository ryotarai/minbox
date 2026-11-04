import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { TerminalHandle } from './Terminal'
import { cx } from './ui'

const KEYS: { id: string; label: string; seq: string; ctrlSeq?: string }[] = [
  { id: 'esc', label: 'Esc', seq: '\x1b' },
  { id: 'tab', label: 'Tab', seq: '\t' },
  { id: 'ctrl-c', label: '^C', seq: '\x03' },
  { id: 'up', label: '↑', seq: '\x1b[A', ctrlSeq: '\x1b[1;5A' },
  { id: 'down', label: '↓', seq: '\x1b[B', ctrlSeq: '\x1b[1;5B' },
  { id: 'left', label: '←', seq: '\x1b[D', ctrlSeq: '\x1b[1;5D' },
  { id: 'right', label: '→', seq: '\x1b[C', ctrlSeq: '\x1b[1;5C' },
]

// A touch screen as the main pointer (phones, tablets, foldables): there is likely no
// physical keyboard, so the terminal needs on-screen Esc / Tab / Ctrl / arrows.
const touchQuery = window.matchMedia('(pointer: coarse)')
export function useTouchPrimary(): boolean {
  return useSyncExternalStore(
    (l) => {
      touchQuery.addEventListener('change', l)
      return () => touchQuery.removeEventListener('change', l)
    },
    () => touchQuery.matches,
  )
}

/**
 * The row of terminal keys a soft keyboard lacks. `wrap` is the element around the
 * terminal: while Ctrl is armed, the next letter typed there becomes its control character.
 */
export function TerminalKeys({ term, wrap, className }: { term: RefObject<TerminalHandle | null>; wrap: RefObject<HTMLElement | null>; className?: string }) {
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (!ctrlRef.current || e.key.length !== 1) return
      const c = e.key.toLowerCase().charCodeAt(0)
      if (c < 97 || c > 122) return
      e.preventDefault()
      e.stopPropagation()
      term.current?.send(String.fromCharCode(c - 96))
      setCtrl(false)
    }
    el.addEventListener('keydown', onKey, true)
    return () => el.removeEventListener('keydown', onKey, true)
  }, [term, wrap])

  const press = (k: (typeof KEYS)[number]) => {
    term.current?.send(ctrl && k.ctrlSeq ? k.ctrlSeq : k.seq)
    setCtrl(false)
  }

  return (
    <div role="toolbar" aria-label="Terminal keys" className={cx('flex shrink-0 gap-1.5', className)}>
      {KEYS.slice(0, 2).map((k) => (
        <KeyBtn key={k.id} id={k.id} onPress={() => press(k)}>
          {k.label}
        </KeyBtn>
      ))}
      <button
        type="button"
        data-testid="term-key-ctrl"
        aria-pressed={ctrl}
        onClick={() => setCtrl((v) => !v)}
        className={cx('box-border h-11 min-w-0 flex-[1.15] rounded-lg text-[14px] font-bold', ctrl ? 'border border-accent bg-wait/16 text-waitfg' : 'border-0 bg-key')}
      >
        Ctrl
      </button>
      {KEYS.slice(2).map((k) => (
        <KeyBtn key={k.id} id={k.id} onPress={() => press(k)} label={k.id}>
          {k.label}
        </KeyBtn>
      ))}
    </div>
  )
}

export function KeyBtn({ id, onPress, children, label }: { id: string; onPress: () => void; children: React.ReactNode; label?: string }) {
  return (
    <button
      type="button"
      data-testid={`term-key-${id}`}
      aria-label={label ? label[0]!.toUpperCase() + label.slice(1) : undefined}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPress}
      className="h-11 min-w-0 flex-1 rounded-lg border-0 bg-key text-[14px] font-semibold"
    >
      {children}
    </button>
  )
}

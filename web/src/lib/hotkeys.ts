import { useEffect, useRef } from 'react'
import { isMac } from './format'

// Keyboard shortcuts. Components register handlers by key; the newest
// registration of a key wins (an open dialog over the list, for instance).
// Single keys are off while typing, inside the terminal, or when the person
// turned them off in Settings; ⌘K works everywhere.

type Handler = (e: KeyboardEvent) => boolean | void
type Entry = { keys: Record<string, Handler>; order: number }

const entries = new Set<Entry>()
let counter = 0
let singleKeys = true

export function setSingleKeysEnabled(v: boolean) {
  singleKeys = v
}

export function isTyping(target: EventTarget | null = document.activeElement): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  return el.isContentEditable === true
}

export function inTerminal(target: EventTarget | null = document.activeElement): boolean {
  const el = target as HTMLElement | null
  return !!el?.closest?.('[data-testid="terminal"]')
}

/** "mod+k", "shift+e", "?", "j", "escape", "arrowdown", "enter", "shift+f10", "]". */
export function keyOf(e: KeyboardEvent): string {
  const parts: string[] = []
  // "mod" is ⌘ on a Mac (Ctrl stays the terminal's: Ctrl+K kills the line),
  // Ctrl elsewhere.
  if (isMac() ? e.metaKey : e.ctrlKey) parts.push('mod')
  else if (e.ctrlKey || e.metaKey) parts.push('ctrl')
  if (e.altKey) parts.push('alt')
  let k = e.key.toLowerCase()
  if (k === ' ') k = 'space'
  // Shift is part of printable keys already ("?" not "shift+/"), except letters and function keys.
  if (e.shiftKey && (k.length > 1 || /[a-z]/.test(k))) parts.push('shift')
  parts.push(k)
  return parts.join('+')
}

/** Keys that work while typing or in the terminal. */
const GLOBAL = new Set(['mod+k', 'mod+b', 'escape', 'mod+enter'])

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return
  const key = keyOf(e)
  const typing = isTyping(e.target)
  const terminal = inTerminal(e.target)
  if (terminal && key !== 'mod+k') return
  if (typing && !GLOBAL.has(key)) return
  const single = !key.startsWith('mod+') && key !== 'escape'
  if (single && !singleKeys && !['arrowup', 'arrowdown', 'enter'].includes(key)) return
  const sorted = [...entries].sort((a, b) => b.order - a.order)
  for (const en of sorted) {
    const h = en.keys[key]
    if (!h) continue
    const handled = h(e)
    if (handled !== false) {
      e.preventDefault()
      return
    }
  }
}

/** ⌘K must work inside the terminal too: catch it before the terminal does. */
function onCapture(e: KeyboardEvent) {
  if (keyOf(e) !== 'mod+k' || !inTerminal(e.target)) return
  e.stopPropagation()
  onKeyDown(e)
}

let installed = false
function install() {
  if (installed) return
  installed = true
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keydown', onCapture, true)
}

/** Registers shortcut handlers while the component is mounted (and enabled). */
export function useHotkeys(keys: Record<string, Handler>, enabled = true) {
  const ref = useRef(keys)
  ref.current = keys
  useEffect(() => {
    if (!enabled) return
    install()
    const proxy: Record<string, Handler> = {}
    for (const k of Object.keys(ref.current)) proxy[k] = (e) => ref.current[k]?.(e)
    const entry: Entry = { keys: proxy, order: ++counter }
    entries.add(entry)
    return () => {
      entries.delete(entry)
    }
    // Re-register only when the set of keys changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, Object.keys(keys).sort().join(',')])
}

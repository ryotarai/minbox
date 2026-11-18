// Quoting (as in the thread view before v3): select text in the messages of a stream or a task, and a
// Reply bubble quotes it into the reply box; R does the same while text is selected.
import { useEffect, useState, type RefObject } from 'react'
import { useApp } from '../lib/app'
import { selectedQuote } from '../components/ThreadView'

const QUOTE_EVENT = 'minbox:v3-quote'

/** Puts text into the reply box as a quote (the Composer on screen takes it). */
export function quoteIntoComposer(text: string) {
  if (!text.trim()) return
  window.getSelection()?.removeAllRanges()
  window.dispatchEvent(new CustomEvent(QUOTE_EVENT, { detail: text }))
}

/** The Composer's side: appends a quote block to its text and focuses the box after it. */
export function useQuoteTarget(setText: (f: (t: string) => string) => void, box: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const on = (e: Event) => {
      const text = String((e as CustomEvent).detail ?? '')
      const block = text.split('\n').map((l) => (l.trim() ? `> ${l}` : '>')).join('\n')
      setText((t) => (t.trim() ? `${t.replace(/\s+$/, '')}\n\n${block}\n\n` : `${block}\n\n`))
      requestAnimationFrame(() => {
        const el = box.current
        if (!el) return
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
        el.scrollTop = el.scrollHeight
      })
    }
    window.addEventListener(QUOTE_EVENT, on)
    return () => window.removeEventListener(QUOTE_EVENT, on)
  }, [setText, box])
}

/** The text selected in the conversation on screen ('' when none), for R. */
export function selectedInConversation(): string {
  const box = document.querySelector<HTMLElement>('[data-quote-box]')
  return selectedQuote(box, true)
}

/** The Reply bubble at the end of a selection inside `box`. */
export function QuoteBubble({ box }: { box: RefObject<HTMLElement | null> }) {
  const { isPhone } = useApp()
  const [quote, setQuote] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const evaluate = () => {
      const sel = window.getSelection()
      const text = selectedQuote(box.current)
      if (!sel || !text || sel.rangeCount === 0) return setQuote(null)
      const range = sel.getRangeAt(0)
      const rects = range.getClientRects()
      const r = rects.length ? rects[rects.length - 1]! : range.getBoundingClientRect()
      const first = rects.length ? rects[0]! : r
      // On touch the OS toolbar sits above the selection, so go under it.
      const touch = window.matchMedia('(pointer: coarse)').matches
      const below = touch ? r.bottom + 70 <= window.innerHeight : first.top < 48
      setQuote({ text, x: Math.min(Math.max(r.right, 100), window.innerWidth - 8), y: below ? r.bottom + (touch ? 30 : 6) : first.top - (touch ? 44 : 6), below })
    }
    const on = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(evaluate, 150)
    }
    document.addEventListener('selectionchange', on)
    return () => {
      document.removeEventListener('selectionchange', on)
      if (timer) clearTimeout(timer)
    }
  }, [box])
  if (!quote) return null
  return (
    <button
      type="button"
      className="v-quote"
      data-testid="quote-reply"
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.preventDefault()} // a tap must not clear the selection before the click
      onClick={() => {
        quoteIntoComposer(quote.text)
        setQuote(null)
      }}
      title={isPhone ? undefined : 'Reply (R)'}
      style={{ left: quote.x, top: quote.y, transform: quote.below ? 'translateX(-100%)' : 'translate(-100%, -100%)' }}
    >
      ❝ Reply {!isPhone && <span className="v-kbd">R</span>}
    </button>
  )
}

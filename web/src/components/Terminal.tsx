import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { FitAddon, Ghostty, Terminal as GhosttyTerminal } from 'ghostty-web'
import { uploadImage } from '../api'
import { cx } from './ui'

const THEME = {
  background: '#0e0e11',
  foreground: '#d4d4d8',
  cursor: '#f2b14a',
  selectionBackground: '#3a3a42',
  black: '#18181c',
  red: '#ff8a70',
  green: '#6fd6a0',
  yellow: '#f2b14a',
  blue: '#82aefc',
  magenta: '#b79cff',
  cyan: '#67d4e8',
  white: '#d4d4d8',
  brightBlack: '#6b6b75',
  brightRed: '#ffb3a1',
  brightGreen: '#9ae6bf',
  brightYellow: '#ffd28a',
  brightBlue: '#a9c7ff',
  brightMagenta: '#d2c1ff',
  brightCyan: '#a0e8f4',
  brightWhite: '#ededf0',
}

/**
 * Text size zooms the page (CSS zoom on #root). ghostty-web turns mouse
 * positions into cells with the event's offsetX/offsetY and the canvas's
 * client rect, which are in zoomed pixels, divided by its cell size in
 * unzoomed ones: under a zoom of 1.2 a press 20 rows down lands 4 rows lower.
 * Scale its pixel→cell conversions (selection and its auto-scroll at the edges; link hover and click) by the
 * canvas's zoom, read from its drawn size over its layout size.
 */
function zoomAware(term: GhosttyTerminal) {
  const t = term as unknown as {
    canvas?: HTMLCanvasElement
    renderer?: { getMetrics(): { width: number; height: number } }
    selectionManager?: {
      pixelToCell(x: number, y: number): { col: number; row: number }
      updateAutoScroll(y: number, height: number): void
    }
  }
  const zoom = () => {
    const c = t.canvas
    if (!c || !c.offsetWidth) return 1
    return c.getBoundingClientRect().width / c.offsetWidth || 1
  }
  const sm = t.selectionManager
  if (sm) {
    const pixelToCell = sm.pixelToCell.bind(sm)
    sm.pixelToCell = (x, y) => {
      const z = zoom()
      return pixelToCell(x / z, y / z)
    }
    // Dragging near an edge scrolls: the offset is zoomed, the height is not.
    const updateAutoScroll = sm.updateAutoScroll.bind(sm)
    sm.updateAutoScroll = (y, height) => updateAutoScroll(y / zoom(), height)
  }
  const r = t.renderer
  if (r) {
    Object.defineProperty(r, 'charWidth', { get: () => r.getMetrics().width * zoom() })
    Object.defineProperty(r, 'charHeight', { get: () => r.getMetrics().height * zoom() })
  }
}

/**
 * Repaints from scratch. The canvas is drawn by diff, so a canvas that was cleared or
 * measured before the font loaded (seen after a session switch) stays garbled until
 * something forces a full redraw.
 */
function redraw(term: GhosttyTerminal | null | undefined) {
  const t = term as unknown as {
    renderer?: { remeasureFont(): void; render(b: unknown, force: boolean, y: number, p: unknown): void }
    wasmTerm?: unknown
    viewportY?: number
  }
  if (!t?.renderer || !t.wasmTerm) return
  try {
    t.renderer.remeasureFont()
    t.renderer.render(t.wasmTerm, true, t.viewportY ?? 0, term)
  } catch {
    /* terminal already disposed */
  }
}

/** Shell-quotes a path when it holds characters a shell would split on. */
export function shellQuote(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

export type TerminalHandle = {
  /** Sends input to the PTY, as if typed. */
  send: (data: string) => void
  focus: () => void
}

type Props = {
  sessionId: string
  /** Focus the terminal once it opens (not on a phone: that raises the keyboard). */
  autoFocus?: boolean
  fontSize?: number
  /** Shift+Enter inserts a newline in Claude Code's prompt (it sends ESC CR, as Claude Code's own terminal setup does) instead of submitting. Not for a shell. */
  newlineOnShiftEnter?: boolean
  onSize?: (cols: number, rows: number) => void
  onNotice: (text: string, error?: boolean) => void
  className?: string
}

/**
 * A ghostty-web terminal attached over WebSocket to the session's PTY in the
 * terminal host (through the server).
 */
export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView(
  { sessionId, autoFocus = true, fontSize = 13, newlineOnShiftEnter = true, onSize, onNotice, className },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting')
  const api = useRef<TerminalHandle>({ send: () => {}, focus: () => {} })
  useImperativeHandle(ref, () => ({
    send: (d) => api.current.send(d),
    focus: () => api.current.focus(),
  }))
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize
  const onNoticeRef = useRef(onNotice)
  onNoticeRef.current = onNotice

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let disposed = false
    let ws: WebSocket | null = null
    let stopReconnect: (() => void) | null = null
    let term: GhosttyTerminal | null = null
    let fit: FitAddon | null = null
    let observer: ResizeObserver | null = null
    let untouch: (() => void) | null = null
    const enc = new TextEncoder()
    // Every view tells the host the size it would fit; the PTY takes the
    // smallest of the attached views' and every view draws at that size.
    let wantCols = 0
    let wantRows = 0

    const ime = document.createElement('div')
    ime.className = 'mb-ime'
    ime.setAttribute('aria-hidden', 'true')

    const sendWant = () => {
      if (ws?.readyState === WebSocket.OPEN && wantCols > 0) ws.send(JSON.stringify({ type: 'resize', cols: wantCols, rows: wantRows, lease: true }))
    }
    const measure = () => {
      let d: { cols: number; rows: number } | undefined
      try {
        d = fit?.proposeDimensions()
      } catch {
        /* not laid out yet */
      }
      if (!d || (d.cols === wantCols && d.rows === wantRows)) return
      wantCols = d.cols
      wantRows = d.rows
      sendWant()
      fitsBox()
    }
    // The PTY larger than this view (another view set it, or an older host):
    // let the view scroll; otherwise no scrollbars.
    const fitsBox = () => {
      const box = boxRef.current
      if (!box || !term) return
      const over = wantCols > 0 && (term.cols > wantCols || term.rows > wantRows)
      box.style.overflow = over ? 'auto' : 'hidden'
    }
    let typedAt = 0 // the person's last input: the view follows the cursor for a moment
    const send = (data: string) => {
      typedAt = Date.now()
      if (ws?.readyState === WebSocket.OPEN) ws.send(enc.encode(data))
    }

    const onPaste = async (ev: ClipboardEvent) => {
      const items = ev.clipboardData ? Array.from(ev.clipboardData.items) : []
      const image = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'))
      if (!image) return // text: let the terminal paste it
      const file = image.getAsFile()
      if (!file) return
      ev.preventDefault()
      ev.stopImmediatePropagation()
      try {
        const path = await uploadImage(sessionId, file)
        send(shellQuote(path) + ' ')
        onNoticeRef.current(`Pasted image: ${path}`)
      } catch (err) {
        onNoticeRef.current(`Upload failed: ${(err as Error).message}`, true)
      }
    }

    ;(async () => {
      // Each terminal gets its own wasm instance (own memory). Sharing one, as init() does,
      // lets a trap in one terminal ("memory access out of bounds") corrupt every terminal
      // opened after it, until a page reload.
      const ghostty = await Ghostty.load()
      if (disposed) return
      el.innerHTML = ''
      term = new GhosttyTerminal({
        ghostty,
        fontSize,
        fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
        theme: THEME,
        cursorBlink: true,
        scrollback: 10000,
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(el)
      zoomAware(term)
      // Metrics are measured once: measure again, and repaint, when the font is there.
      document.fonts?.ready.then(() => !disposed && redraw(term))
      el.appendChild(ime)
      if (autoFocus) term.focus()
      // For end-to-end tests: the terminal draws on a canvas, so its text is read from the buffer.
      ;(window as unknown as { __minboxTerminal?: GhosttyTerminal }).__minboxTerminal = term

      api.current = { send, focus: () => term?.focus() }

      // The socket reconnects by itself (a dropped network, a restarted server, a sleeping
      // tablet): the host replays the screen, so the view is reset before the replay is drawn.
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      let attempts = 0
      let retry: ReturnType<typeof setTimeout> | null = null
      // Cellular sockets hang in CONNECTING or go half-open without a close event, so the page
      // also times the connect and treats silence (the server pings) as death. Tests shorten these.
      const T = {
        connectMs: 8000,
        silentMs: 40_000,
        wakeSilentMs: 20_000,
        leaseMs: 5000, // the host drops a size that is not sent again within its TTL
        ...(window as unknown as { __minboxTimings?: object }).__minboxTimings,
      }
      let lastFrame = Date.now()
      let connectTimer: ReturnType<typeof setTimeout> | null = null
      // Drops a socket without waiting for its close event (detached, so a late event cannot
      // act), and schedules the retry with the backoff.
      const abandon = (sock: WebSocket) => {
        if (connectTimer) clearTimeout(connectTimer)
        sock.onopen = sock.onmessage = sock.onclose = null
        try {
          sock.close()
        } catch {
          /* already gone */
        }
        setState('closed')
        attempts++
        retry = setTimeout(openSocket, Math.min(1000 * attempts, 10000))
      }
      const openSocket = () => {
        retry = null
        const sock = new WebSocket(`${proto}://${location.host}/api/sessions/${sessionId}/terminal`)
        ws = sock
        sock.binaryType = 'arraybuffer'
        const reconnecting = attempts > 0
        lastFrame = Date.now()
        connectTimer = setTimeout(() => {
          if (!disposed && sock === ws && sock.readyState !== WebSocket.OPEN) abandon(sock)
        }, T.connectMs)
        sock.onopen = () => {
          if (connectTimer) clearTimeout(connectTimer)
          lastFrame = Date.now()
          attempts = 0
          setState('open')
          measure()
          sendWant()
        }
        // The replay is drawn once the PTY's size is known (it comes after it).
        let held: (Uint8Array | string)[] | null = []
        const flush = () => {
          if (!held || sock !== ws) return // an abandoned socket must not reset the new one's screen
          if (reconnecting) term?.write('\x1bc') // RIS: the replay starts from a clean screen
          for (const d of held) term?.write(d)
          held = null
        }
        setTimeout(flush, 1500)
        const write = (d: Uint8Array | string) => {
          if (held) held.push(d)
          else term?.write(d)
        }
        sock.onmessage = (e) => {
          if (sock !== ws) return
          lastFrame = Date.now()
          if (e.data instanceof ArrayBuffer) {
            write(new Uint8Array(e.data))
            return
          }
          const text = String(e.data)
          if (text.startsWith('{') && text.includes('"type"')) {
            try {
              const msg = JSON.parse(text) as { type: string; cols: number; rows: number }
              if (msg.type === 'ping') return // the server's keep-alive, not terminal output
              if (msg.type === 'size') {
                onSizeRef.current?.(msg.cols, msg.rows)
                if (term && (term.cols !== msg.cols || term.rows !== msg.rows)) term.resize(msg.cols, msg.rows)
                fitsBox()
                flush()
                redraw(term)
                return
              }
            } catch {
              /* plain text */
            }
          }
          write(text)
        }
        sock.onclose = () => {
          if (disposed || sock !== ws) return
          if (connectTimer) clearTimeout(connectTimer)
          setState('closed')
          attempts++
          retry = setTimeout(openSocket, Math.min(1000 * attempts, 10000))
        }
      }
      // Back online, or the page is shown again: do not wait for the timer, and replace a
      // socket that is not open or has gone quiet.
      const wake = () => {
        if (disposed) return
        if (retry) {
          clearTimeout(retry)
          openSocket()
        } else if (ws && (ws.readyState !== WebSocket.OPEN || Date.now() - lastFrame > T.wakeSilentMs)) {
          abandon(ws)
          if (retry) clearTimeout(retry)
          openSocket()
        }
      }
      const silence = setInterval(() => {
        if (disposed || retry || !ws || ws.readyState !== WebSocket.OPEN) return
        if (Date.now() - lastFrame > T.silentMs) abandon(ws)
      }, Math.max(250, Math.min(5000, T.silentMs / 4)))
      // The size is a lease the host lets lapse: it is repeated only while the page is shown,
      // so a hidden page (phone locked) or a dead connection stops limiting the PTY.
      const lease = setInterval(() => {
        if (document.visibilityState === 'visible') sendWant()
      }, T.leaseMs)
      const onVisible = () => {
        if (document.visibilityState !== 'visible') return
        sendWant()
        redraw(term)
        wake()
      }
      window.addEventListener('online', wake)
      document.addEventListener('visibilitychange', onVisible)
      stopReconnect = () => {
        if (retry) clearTimeout(retry)
        if (connectTimer) clearTimeout(connectTimer)
        clearInterval(silence)
        clearInterval(lease)
        window.removeEventListener('online', wake)
        document.removeEventListener('visibilitychange', onVisible)
      }
      openSocket()
      // Mouse wheel. ghostty-web turns the wheel into ↑/↓ keys on the
      // alternate screen, even when the program asked for mouse events: Claude
      // Code's full-screen UI then cycles its prompt history instead of
      // scrolling the conversation. When the program tracks the mouse, report
      // the wheel as mouse buttons 64/65, in the encoding it asked for.
      // Scrolling by n lines (negative: back) at a point on the screen. A
      // program that tracks the mouse gets wheel buttons 64/65 in the encoding
      // it asked for (ghostty-web would send ↑/↓ keys on the alternate screen,
      // and Claude Code's full-screen UI would cycle its prompt history).
      // The 1-based cell under a point (in zoomed pixels, as events give them).
      const cellAt = (clientX: number, clientY: number): [number, number] => {
        const canvas = el.querySelector('canvas')
        if (!term || !canvas) return [1, 1]
        const r = canvas.getBoundingClientRect()
        const col = Math.min(term.cols, Math.max(1, Math.floor((clientX - r.left) / (r.width / term.cols)) + 1))
        const row = Math.min(term.rows, Math.max(1, Math.floor((clientY - r.top) / (r.height / term.rows)) + 1))
        return [col, row]
      }
      // A mouse report in the encoding the program asked for (SGR, urxvt, X10).
      const mouseSeq = (btn: number, col: number, row: number, release: boolean): string => {
        if (term?.getMode(1006)) return `\x1b[<${btn};${col};${row}${release ? 'm' : 'M'}`
        const b = release ? 3 + (btn & ~3) : btn // the old encodings release as button 3
        if (term?.getMode(1015)) return `\x1b[${b + 32};${col};${row}M`
        return `\x1b[M${String.fromCharCode(32 + b, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`
      }
      const scrollAt = (n: number, clientX: number, clientY: number, mods = 0): boolean => {
        if (!term) return false
        const canvas = el.querySelector('canvas')
        if (!canvas) return false
        if (term.hasMouseTracking()) {
          const [col, row] = cellAt(clientX, clientY)
          const seq = mouseSeq((n < 0 ? 64 : 65) + mods, col, row, false)
          for (let i = 0; i < Math.min(Math.abs(n), 10); i++) send(seq)
        } else if (term.buffer.active.type === 'alternate') {
          // A full-screen program without the mouse: arrow keys, as a wheel does.
          const key = n < 0 ? '\x1b[A' : '\x1b[B'
          for (let i = 0; i < Math.min(Math.abs(n), 10); i++) send(key)
        } else {
          term.scrollLines(n) // the scrollback
        }
        return true
      }
      const cellHeight = () => {
        const canvas = el.querySelector('canvas')
        return canvas && term ? canvas.getBoundingClientRect().height / term.rows : 16
      }

      let wheelAcc = 0
      term.attachCustomWheelEventHandler((e: WheelEvent) => {
        if (!term || !term.hasMouseTracking()) return false
        const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * term.rows : e.deltaY / cellHeight()
        wheelAcc += lines
        const n = Math.trunc(wheelAcc)
        if (n === 0) return true
        wheelAcc -= n
        return scrollAt(n, e.clientX, e.clientY, (e.shiftKey ? 4 : 0) + (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0))
      })

      // Touch: a swipe scrolls like the wheel (with a little momentum); a tap
      // is still a tap (focus, the keyboard).
      let touch: { y: number; x: number; acc: number; moved: boolean; v: number; t: number } | null = null
      let glide = 0
      const onTouchStart = (e: TouchEvent) => {
        cancelAnimationFrame(glide)
        if (e.touches.length !== 1) {
          touch = null
          return
        }
        const p = e.touches[0]!
        touch = { y: p.clientY, x: p.clientX, acc: 0, moved: false, v: 0, t: performance.now() }
      }
      const onTouchMove = (e: TouchEvent) => {
        if (!touch || e.touches.length !== 1) return
        const p = e.touches[0]!
        const dy = p.clientY - touch.y
        if (!touch.moved && Math.abs(dy) < 8) return
        touch.moved = true
        e.preventDefault() // the page does not bounce; the terminal scrolls
        const now = performance.now()
        touch.v = dy / Math.max(1, now - touch.t) // px per ms
        touch.t = now
        touch.y = p.clientY
        touch.acc -= dy / cellHeight() // finger up: forward
        const n = Math.trunc(touch.acc)
        if (n !== 0) {
          touch.acc -= n
          scrollAt(n, touch.x, p.clientY)
        }
      }
      const onTouchEnd = () => {
        if (!touch?.moved) {
          touch = null
          return
        }
        let v = -touch.v // lines go the other way from the finger
        const x = touch.x
        const y = touch.y
        let acc = 0
        let last = performance.now()
        touch = null
        const step = (now: number) => {
          const dt = now - last
          last = now
          v *= Math.pow(0.995, dt) // ease out over about a second
          if (Math.abs(v) < 0.05) return
          acc += (v * dt) / cellHeight()
          const n = Math.trunc(acc)
          if (n !== 0) {
            acc -= n
            scrollAt(n, x, y)
          }
          glide = requestAnimationFrame(step)
        }
        if (Math.abs(v) > 0.3) glide = requestAnimationFrame(step)
      }
      el.addEventListener('touchstart', onTouchStart, { passive: true })
      el.addEventListener('touchmove', onTouchMove, { passive: false })
      el.addEventListener('touchend', onTouchEnd)
      el.addEventListener('touchcancel', onTouchEnd)
      untouch = () => {
        cancelAnimationFrame(glide)
        el.removeEventListener('touchstart', onTouchStart)
        el.removeEventListener('touchmove', onTouchMove)
        el.removeEventListener('touchend', onTouchEnd)
        el.removeEventListener('touchcancel', onTouchEnd)
      }

      // Mouse buttons. ghostty-web reports only the wheel to a program that
      // tracks the mouse; a click goes to its own text selection. Report
      // presses, releases and (modes 1002/1003) motion, so Claude Code's
      // full-screen UI can be clicked. Shift+drag still selects text here, as
      // in other terminals.
      let pressed: number | null = null
      let lastCell = ''
      const modsOf = (e: MouseEvent) => (e.altKey ? 8 : 0) + (e.ctrlKey ? 16 : 0)
      const onMouseDown = (e: MouseEvent) => {
        if (!term || !term.hasMouseTracking() || e.shiftKey || e.button > 1) return
        if (!(e.target instanceof HTMLCanvasElement)) return
        e.stopPropagation() // not ghostty-web's selection
        e.preventDefault()
        term.focus()
        const [col, row] = cellAt(e.clientX, e.clientY)
        pressed = e.button
        lastCell = `${col},${row}`
        send(mouseSeq(pressed + modsOf(e), col, row, false))
      }
      const onMouseMove = (e: MouseEvent) => {
        if (!term || !term.hasMouseTracking()) return
        const drag = pressed !== null && (term.getMode(1002) || term.getMode(1003))
        const hover = pressed === null && term.getMode(1003) && e.target instanceof HTMLCanvasElement && el.contains(e.target)
        if (!drag && !hover) return
        const [col, row] = cellAt(e.clientX, e.clientY)
        const cell = `${col},${row}`
        if (cell === lastCell) return
        lastCell = cell
        send(mouseSeq(32 + (pressed ?? 3) + modsOf(e), col, row, false))
      }
      const onMouseUp = (e: MouseEvent) => {
        if (pressed === null) return
        const b = pressed
        pressed = null
        if (!term || !term.hasMouseTracking()) return
        const [col, row] = cellAt(e.clientX, e.clientY)
        send(mouseSeq(b + modsOf(e), col, row, true))
      }
      el.addEventListener('mousedown', onMouseDown, true)
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      const unmouse = () => {
        el.removeEventListener('mousedown', onMouseDown, true)
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
      }
      const untouchOnly = untouch
      untouch = () => {
        untouchOnly?.()
        unmouse()
      }

      // When the PTY is larger than the view (it scrolls), and when the view
      // shrinks (a phone's keyboard comes up): keep the cursor's cell in view
      // then, and while the person types (not while they scroll to read).
      const revealCursor = () => {
        const box = boxRef.current
        const canvas = el.querySelector('canvas')
        if (!term || !box || !canvas) return
        const cw = canvas.clientWidth / term.cols
        const ch = canvas.clientHeight / term.rows
        const buf = term.buffer.active
        const pad = canvas.offsetTop
        const top = pad + buf.cursorY * ch
        const left = canvas.offsetLeft + buf.cursorX * cw
        const margin = ch
        if (top + ch + margin > box.scrollTop + box.clientHeight) box.scrollTop = top + ch + margin - box.clientHeight
        else if (top - margin < box.scrollTop) box.scrollTop = Math.max(0, top - margin)
        if (left + cw * 4 > box.scrollLeft + box.clientWidth) box.scrollLeft = left + cw * 4 - box.clientWidth
        else if (left - cw * 4 < box.scrollLeft) box.scrollLeft = Math.max(0, left - cw * 4)
      }
      term.onCursorMove(() => {
        if (Date.now() - typedAt < 1500) requestAnimationFrame(revealCursor)
      })
      term.onData((data: string) => send(data))
      // A plain terminal sends the same CR for Shift+Enter as for Enter, so Claude Code submits.
      if (newlineOnShiftEnter) {
        term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return false
          if (e.type === 'keydown') send('\x1b\r')
          e.preventDefault()
          return true
        })
      }
      // Measure now, and again once the layout settles (a window resize passes
      // through transient sizes while the columns re-flow).
      measure()
      if (boxRef.current) {
        let lastH = boxRef.current.clientHeight
        let settle: ReturnType<typeof setTimeout> | null = null
        observer = new ResizeObserver(() => {
          const h = boxRef.current?.clientHeight ?? 0
          if (h < lastH) requestAnimationFrame(revealCursor) // shrank: e.g. the keyboard came up
          lastH = h
          measure()
          if (settle) clearTimeout(settle)
          settle = setTimeout(measure, 150)
        })
        observer.observe(boxRef.current)
      }
    })()

    // IME: ghostty-web lets the browser put the composing text into the
    // (contenteditable) host after the canvas, i.e. below the terminal. Lay the
    // canvas over the host and start the text flow at the cursor cell, so the
    // browser's own caret, and the IME candidate window with it, sit at the
    // cursor; the text itself is drawn by an overlay over that cell.
    const placeIme = (text: string) => {
      const canvas = el.querySelector('canvas')
      if (!term || !canvas) return
      const cw = canvas.clientWidth / term.cols
      const ch = canvas.clientHeight / term.rows
      const buf = term.buffer.active
      const x = canvas.offsetLeft + buf.cursorX * cw
      const y = canvas.offsetTop + buf.cursorY * ch
      el.style.setProperty('--ime-x', `${x}px`)
      el.style.setProperty('--ime-y', `${y}px`)
      el.style.setProperty('--ime-h', `${ch}px`)
      el.style.setProperty('--ime-font', `${fontSize}px`)
      ime.style.left = `${x}px`
      ime.style.top = `${y}px`
      ime.style.height = `${ch}px`
      ime.style.lineHeight = `${ch}px`
      ime.style.fontSize = `${fontSize}px`
      ime.textContent = text
      ime.style.display = text ? 'block' : 'none'
    }
    const onCompStart = () => {
      el.classList.add('mb-composing')
      placeIme('')
    }
    const onCompUpdate = (e: CompositionEvent) => placeIme(e.data ?? '')
    const onCompEnd = () => {
      el.classList.remove('mb-composing')
      placeIme('')
    }
    el.addEventListener('compositionstart', onCompStart)
    el.addEventListener('compositionupdate', onCompUpdate)
    el.addEventListener('compositionend', onCompEnd)

    // Capture phase: an image paste must not reach the terminal's own handler.
    el.addEventListener('paste', onPaste, true)

    return () => {
      disposed = true
      stopReconnect?.()
      el.removeEventListener('paste', onPaste, true)
      el.removeEventListener('compositionstart', onCompStart)
      el.removeEventListener('compositionupdate', onCompUpdate)
      el.removeEventListener('compositionend', onCompEnd)
      untouch?.()
      ime.remove()
      observer?.disconnect()
      ws?.close()
      const w = window as unknown as { __minboxTerminal?: GhosttyTerminal }
      if (w.__minboxTerminal === term) delete w.__minboxTerminal
      term?.dispose()
      api.current = { send: () => {}, focus: () => {} }
    }
  }, [sessionId, autoFocus, fontSize])

  return (
    <div ref={boxRef} className={cx('relative h-full w-full overflow-hidden', className)}>
      <div ref={hostRef} data-testid="terminal" className="mb-term absolute inset-0" />
      {state !== 'open' && (
        <div className="pointer-events-none absolute right-3 top-2 text-[12px] text-subtle">{state === 'connecting' ? 'connecting…' : 'disconnected'}</div>
      )}
    </div>
  )
})

import { useEffect, useMemo, useRef, useState } from 'react'
import { uploadImage, type Session } from '../api'
import { useApp } from '../lib/app'
import { homeRelative } from '../lib/format'
import { IconArchive, IconBack, IconClose, IconTerminal, IconImage, IconMail } from './icons'
import { waitsOnPerson } from './Sidebar'
import { TerminalView, shellQuote, type TerminalHandle } from './Terminal'
import { Segmented, StatusDot, cx, statusOf } from './ui'
import { api } from '../api'
import { ThreadView, unreadElsewhere, useThread } from './ThreadView'
import { useAllThreads } from './ThreadList'
import { ThreadsPane, useVisibleThreads } from './ThreadsPane'
import { TerminalKeys } from './TerminalKeys'

/**
 * Follows the visual viewport, so bars stay above the on-screen keyboard, and
 * tells whether the keyboard is up (the viewport is well short of the tallest
 * it has been at this width).
 */
function useViewport(): { h: number | null; keyboard: boolean } {
  const [v, setV] = useState<{ h: number | null; keyboard: boolean }>({ h: window.visualViewport?.height ?? null, keyboard: false })
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    let tallest = vv.height
    let width = window.innerWidth
    const on = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth // turned: start over
        tallest = vv.height
      }
      tallest = Math.max(tallest, vv.height)
      setV({ h: vv.height, keyboard: tallest - vv.height > 120 })
      window.scrollTo(0, 0)
    }
    vv.addEventListener('resize', on)
    vv.addEventListener('scroll', on)
    return () => {
      vv.removeEventListener('resize', on)
      vv.removeEventListener('scroll', on)
    }
  }, [])
  return v
}

export function PhoneApp() {
  const { route, sessions } = useApp()
  const { h, keyboard } = useViewport()
  const session = sessions?.find((s) => s.id === route.s) ?? null
  // Home is the thread list; a thread opens over it; its session's terminal is one flip away.
  const screen = session && route.tab === 'terminal' ? 'terminal' : session && route.t ? 'thread' : 'home'
  return (
    <div className="relative flex w-full flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top)]" style={{ height: h ?? '100dvh' }} data-testid="phone" data-screen={screen} data-keyboard={keyboard || undefined}>
      {screen === 'home' ? (
        <div className="min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]" data-testid="phone-home">
          <ThreadsPane phone />
        </div>
      ) : (
        <PhoneSession session={session!} keyboard={keyboard} />
      )}
    </div>
  )
}

function PhoneSession({ session, keyboard }: { session: Session; keyboard: boolean }) {
  const { route, navigate, error, toast } = useApp()
  const [thread] = useThread(route.t)
  const all = useAllThreads()
  const v = useVisibleThreads()
  const siblings = useMemo(() => v.groups.flatMap((g) => g.items), [v.groups])
  const st = statusOf(session, waitsOnPerson(session))
  const terminal = route.tab === 'terminal'
  const inThread = !terminal && !!route.t
  const home = () => navigate({ t: null, f: null, tab: 'inbox' }, { push: false })
  const back = () => {
    if (terminal && route.t) navigate({ tab: 'inbox' }, { push: false })
    else home()
  }
  const othersUnread = unreadElsewhere(all, route.t)
  // Typing in the terminal: the keyboard takes half the screen, so the
  // terminal takes the rest (the header and tabs come back with the keyboard down).
  const typing = keyboard && (terminal || session.kind === 'shell')
  const [shellOpen, setShellOpen] = useState(false)
  return (
    <>
      {shellOpen && session.kind !== 'shell' && session.status !== 'ended' && <PhoneShell session={session} typing={keyboard} onClose={() => setShellOpen(false)} />}
      <header className={cx('flex h-14 shrink-0 items-center gap-0.5 px-1.5', inThread && 'border-b border-line', typing && 'hidden')}>
        <button
          type="button"
          data-testid="mobile-back"
          aria-label={terminal && route.t ? 'Back to the thread' : 'Back to threads'}
          onClick={back}
          className="flex h-11 min-w-11 items-center gap-0.5 rounded-[10px] border-0 bg-transparent px-1.5 text-fg2"
        >
          <IconBack size={20} />
          {othersUnread > 0 && (
            <span data-testid="back-badge" title="Other threads have new messages" className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[12px] font-extrabold text-onaccent">
              {othersUnread}
            </span>
          )}
        </button>
        {inThread ? (
          <>
            <div className="flex min-w-0 flex-1 flex-col items-start">
              <span data-testid="phone-thread-subject" className="max-w-full truncate text-[15.5px] font-[650]">
                {thread?.subject ?? '…'}
              </span>
              <button
                type="button"
                data-testid="phone-session-chip"
                aria-label={`Open ${session.name}'s terminal`}
                onClick={() => navigate({ tab: 'terminal' }, { push: false })}
                className="mono flex max-w-full items-center gap-1.5 rounded-[5px] border-0 bg-chip px-1.5 text-[11.5px] leading-[18px] text-fg2"
              >
                <StatusDot s={session} waits={waitsOnPerson(session)} size={6} ring={false} />
                <span className="truncate">{session.name}</span>
                <IconTerminal size={11} />
              </button>
            </div>
            <button
              type="button"
              aria-label="Mark unread"
              onClick={() => route.t && api.markUnread(route.t).then(home).catch(error)}
              className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2"
            >
              <IconMail size={19} />
            </button>
            <button
              type="button"
              aria-label="Archive"
              data-testid="thread-archive"
              onClick={() => {
                const id = route.t
                if (!id) return
                api
                  .archiveThread(id)
                  .then(() => {
                    toast(`Archived · "${thread?.subject ?? ''}"`, { action: 'Undo', undo: true, onAction: () => api.unarchiveThread(id).catch(error) })
                    home()
                  })
                  .catch(error)
              }}
              className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2"
            >
              <IconArchive size={19} />
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-1 flex-col items-center">
              <span className="text-[16px] font-[650]" data-testid="terminal-session-name">
                {session.name}
              </span>
              <span className={cx('flex items-center gap-1.5 text-[12px]', st.text)} data-testid="session-status">
                <StatusDot s={session} waits={waitsOnPerson(session)} size={6} ring={false} />
                {st.label}
              </span>
            </div>
            {session.kind !== 'shell' ? (
              <button
                type="button"
                data-testid="shell-toggle"
                aria-label="Open shell"
                onClick={() => setShellOpen(true)}
                className="flex h-11 w-[52px] items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2"
              >
                <IconTerminal size={20} />
              </button>
            ) : (
              <span className="w-[52px]" />
            )}
          </>
        )}
      </header>
      {terminal && route.t && !typing && (
        <div className="mx-3 mb-2 mt-0.5 shrink-0" role="tablist">
          <Segmented
            size="lg"
            value={route.tab}
            onChange={(tab) => navigate({ tab }, { push: false })}
            testidPrefix="mobile-tab"
            options={[
              { value: 'inbox', label: 'Thread' },
              { value: 'terminal', label: 'Terminal' },
            ]}
          />
        </div>
      )}
      {inThread ? (
        <section data-testid="inbox-pane" className="flex min-h-0 flex-1 flex-col">
          <ThreadView key={route.t!} session={session} threadId={route.t!} siblings={siblings} onBack={home} phone />
        </section>
      ) : (
        <PhoneTerminal session={session} typing={typing} />
      )}
    </>
  )
}

/** The companion shell, full screen in front of everything. It is mounted only while shown: the shell itself lives on. */
export function PhoneShell({ session, typing, onClose }: { session: Session; typing: boolean; onClose: () => void }) {
  const { toast } = useApp()
  const term = useRef<TerminalHandle>(null)
  const wrap = useRef<HTMLDivElement>(null)
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-surface pt-[env(safe-area-inset-top)]" data-testid="phone-shell">
      <header className={cx('flex h-14 shrink-0 items-center gap-2 px-3', typing && 'hidden')}>
        <span className="text-[16px] font-[650]">Shell</span>
        <span className="mono min-w-0 flex-1 truncate text-[12px] text-subtle">{homeRelative(session.cwd)}</span>
        <button type="button" data-testid="shell-close" aria-label="Close shell" onClick={onClose} className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2">
          <IconClose size={20} />
        </button>
      </header>
      <div ref={wrap} className={cx('relative min-h-0 flex-1 overflow-hidden border-line bg-[var(--mb-term-bg)]', typing ? 'border-y pl-1.5 pt-1' : 'mx-3 rounded-[10px] border pl-3 pt-2.5')}>
        <TerminalView key={session.id} ref={term} sessionId={session.id} shell autoFocus={false} fontSize={11} onNotice={(t, e) => toast(t, { error: e })} />
      </div>
      <TerminalKeys term={term} wrap={wrap} className="mt-2 border-t border-line2 bg-[#1a1a1f] px-2 py-1.5 [[data-theme=light]_&]:bg-raised pb-[max(6px,env(safe-area-inset-bottom))]" />
    </div>
  )
}

function PhoneTerminal({ session, typing }: { session: Session; typing: boolean }) {
  const { toast } = useApp()
  const term = useRef<TerminalHandle>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const ended = session.status === 'ended'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={wrap} className={cx('relative min-h-0 flex-1 overflow-hidden border-line bg-[var(--mb-term-bg)]', typing ? 'border-y pl-1.5 pt-1' : 'mx-3 rounded-[10px] border pl-3 pt-2.5')}>
        <TerminalView
          key={`${session.id}:${ended ? 'ended' : 'running'}`}
          ref={term}
          sessionId={session.id}
          autoFocus={false}
          fontSize={11}
          onNotice={(t, e) => toast(t, { error: e })}
        />
        {ended && (
          <div className="absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-[10px] border border-line2 bg-raised px-3 py-2" data-testid="ended-bar">
            <span className="flex-1 text-[13px] text-fg2">Session ended.</span>
            <button type="button" data-testid="resume" onClick={() => api.restartSession(session.id).catch(() => {})} className="h-9 rounded-lg border-0 bg-accent px-3.5 text-[14px] font-[650] text-onaccent">
              Resume
            </button>
          </div>
        )}
      </div>
      <TerminalKeys term={term} wrap={wrap} className="mt-2 border-t border-line2 bg-[#1a1a1f] px-2 py-1.5 [[data-theme=light]_&]:bg-raised" />
      <div className="flex shrink-0 gap-1.5 bg-[#1a1a1f] px-2 pb-[max(6px,env(safe-area-inset-bottom))] [[data-theme=light]_&]:bg-raised">
        <button
          type="button"
          data-testid="term-upload"
          onClick={() => fileRef.current?.click()}
          className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border-0 bg-key text-[14px]"
        >
          <IconImage size={17} />
          Image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            try {
              const p = await uploadImage(session.id, f)
              term.current?.send(shellQuote(p) + ' ')
              toast(`Pasted image: ${p}`)
            } catch (err) {
              toast(`Upload failed: ${(err as Error).message}`, { error: true })
            }
          }}
        />
        <button type="button" data-testid="term-key-enter" onClick={() => term.current?.send('\r')} className="h-11 flex-1 rounded-lg border-0 bg-[#3a3a42] text-[14px] font-semibold text-white">
          ⏎ Enter
        </button>
      </div>
    </div>
  )
}


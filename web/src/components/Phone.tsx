import { useEffect, useMemo, useRef, useState } from 'react'
import { ATTENTION, SECTION_LABEL, uploadImage, type Session } from '../api'
import { useApp } from '../lib/app'
import { homeRelative } from '../lib/format'
import { IconArchive, IconBack, IconChevronRight, IconClose, IconTerminal, IconImage, IconMail, IconMore, IconPlus, IconSearch } from './icons'
import { InboxPhone } from './PhoneInbox'
import { AllInboxLink, SessionMenu, groupSessions, sectionOf, waitsOnPerson, Logo } from './Sidebar'
import { TerminalView, shellQuote, type TerminalHandle } from './Terminal'
import { ConnectionBanner } from './Banners'
import { PairRequestBanner } from './Devices'
import { HostTag, Segmented, StatusDot, cx, statusOf } from './ui'
import { api } from '../api'
import { useThread } from './ThreadView'
import { unreadElsewhere } from './ThreadView'
import { useThreads } from './ThreadList'
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
  return (
    <div className="relative flex w-full flex-col overflow-hidden bg-surface pt-[env(safe-area-inset-top)]" style={{ height: h ?? '100dvh' }} data-testid="phone" data-keyboard={keyboard || undefined}>
      {session ? <PhoneSession session={session} keyboard={keyboard} /> : <PhoneSessions />}
    </div>
  )
}

function PhoneSessions() {
  const { sessions, setOverlay, navigate } = useApp()
  const [showArchived, setShowArchived] = useState(false)
  const groups = useMemo(() => groupSessions(sessions ?? []), [sessions])
  const need = groups.filter((g) => ATTENTION.includes(g.section))
  const others = groups.filter((g) => !ATTENTION.includes(g.section) && g.section !== 'archived')
  const archived = groups.find((g) => g.section === 'archived')?.rows ?? []
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-1 pl-4 pr-2">
        <Logo size={24} />
        <h1 className="sr-only">minbox</h1>
        <span className="flex-1" />
        <button type="button" aria-label="Quick actions" data-testid="open-palette" onClick={() => setOverlay({ kind: 'palette' })} className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2">
          <IconSearch size={20} />
        </button>
        <button
          type="button"
          aria-label="New session"
          data-testid="new-session"
          onClick={() => setOverlay({ kind: 'new-session' })}
          className="flex h-11 w-11 items-center justify-center rounded-[10px] border-0 bg-transparent text-fg2"
        >
          <IconPlus size={20} />
        </button>
      </header>
      <ConnectionBanner />
      <PairRequestBanner />
      <div data-testid="session-list" className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <AllInboxLink phone />
        {need.length > 0 && (
          <>
            <div className="px-4 pb-1.5 pt-2.5 text-[12px] font-bold uppercase tracking-[0.06em] text-wait">{need.map((g) => SECTION_LABEL[g.section]).join(' · ')}</div>
            {need.flatMap((g) => g.rows).map((s) => (
              <PhoneSessionRow key={s.id} s={s} strong onOpen={() => navigate({ s: s.id, tab: 'inbox' }, { push: true })} />
            ))}
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="px-4 pb-1.5 pt-4 text-[12px] font-bold uppercase tracking-[0.06em] text-subtle">{others.map((g) => SECTION_LABEL[g.section]).join(' · ')}</div>
            {others.flatMap((g) => g.rows).map((s) => (
              <PhoneSessionRow key={s.id} s={s} onOpen={() => navigate({ s: s.id, tab: 'inbox' }, { push: true })} />
            ))}
          </>
        )}
        {archived.length > 0 && (
          <>
            <button
              type="button"
              data-testid="archived-section"
              aria-expanded={showArchived}
              onClick={() => setShowArchived((v) => !v)}
              className="mx-2.5 mt-3.5 flex h-12 shrink-0 items-center gap-2.5 rounded-[10px] border-0 bg-raised px-3.5 text-left text-[14px] text-muted"
            >
              <IconArchive size={16} />
              <span className="flex-1">Archived</span>
              <span className="text-subtle">{archived.length}</span>
              <IconChevronRight size={14} className={cx('transition-transform', showArchived && 'rotate-90')} />
            </button>
            {showArchived && archived.map((s) => <PhoneSessionRow key={s.id} s={s} onOpen={() => navigate({ s: s.id, tab: 'inbox' }, { push: true })} />)}
          </>
        )}
      </div>
    </>
  )
}

function PhoneSessionRow({ s, strong, onOpen }: { s: Session; strong?: boolean; onOpen: () => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState(false)
  const { error, reloadSessions } = useApp()
  const [name, setName] = useState(s.name)
  const ref = useRef<HTMLDivElement>(null)
  const st = statusOf(s, waitsOnPerson(s))
  return (
    <div
      ref={ref}
      data-testid="session-row"
      data-session-id={s.id}
      className={cx('mx-2.5 flex items-center', strong ? 'mb-1.5 min-h-[68px] rounded-xl border border-wait/28 bg-wait/8' : 'min-h-16 border-b border-[#1f1f24] [[data-theme=light]_&]:border-line')}
    >
      {renaming ? (
        <input
          autoFocus
          aria-label="Session name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            setRenaming(false)
            if (name.trim() && name.trim() !== s.name) api.renameSession(s.id, name.trim()).then(reloadSessions).catch(error)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          className="mx-3 h-11 flex-1 rounded-md border border-accent bg-sunken px-3 outline-none"
        />
      ) : (
        <button type="button" onClick={onOpen} className={cx('flex min-w-0 flex-1 flex-col gap-1 border-0 bg-transparent pl-3.5 pr-1 text-left', strong ? 'py-3' : 'py-2.5')}>
          <div className="flex items-center gap-2">
            <StatusDot s={s} waits={strong ?? false} size={9} ring={!!strong} />
            <span data-testid="session-name" className={cx('min-w-0 flex-1 truncate', strong ? 'text-[16px] font-[650]' : 'text-[15.5px] font-medium', s.status === 'ended' && 'text-muted')}>
              {s.name}
            </span>
            <HostTag name={s.host_name} phone />
            {s.open_questions > 0 && (
              <span data-testid="badge-questions" className="flex h-[22px] items-center rounded-full bg-accent px-2 text-[12.5px] font-extrabold text-onaccent">
                ?{s.open_questions}
              </span>
            )}
            {s.unread > 0 && (
              <span data-testid="badge-unread" className="flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[#3a3a42] px-1.5 text-[12.5px] font-bold text-white">
                {s.unread}
              </span>
            )}
          </div>
          {s.title && (
            <span data-testid="session-title" className={cx('truncate pl-[17px] text-[14.5px] font-semibold', s.status === 'ended' ? 'text-muted' : 'text-fg')}>
              {s.title}
            </span>
          )}
          <div className="flex gap-2 pl-[17px] text-[13px]">
            <span className={cx('shrink-0', st.text, strong && 'font-medium')} data-testid="session-status">
              {st.label}
            </span>
            <span className="mono truncate text-[12px] text-subtle">{homeRelative(s.cwd)}</span>
          </div>
        </button>
      )}
      <button
        type="button"
        aria-label="Session menu"
        data-testid="session-menu"
        onClick={() => setAnchor(ref.current)}
        className="mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border-0 bg-transparent text-muted"
      >
        <IconMore size={18} />
      </button>
      <SessionMenu s={s} anchor={anchor} onClose={() => setAnchor(null)} onRename={() => setRenaming(true)} />
    </div>
  )
}

function PhoneSession({ session, keyboard }: { session: Session; keyboard: boolean }) {
  const { route, navigate, sessions, error, toast } = useApp()
  const [thread] = useThread(route.t)
  const sessionThreads = useThreads(session.id)
  const othersWaiting = (sessions ?? []).filter((s) => s.id !== session.id && !s.archived_at && sectionOf(s) !== 'archived' && waitsOnPerson(s)).length
  const st = statusOf(session, waitsOnPerson(session))
  const back = () => {
    if (route.tab === 'inbox' && route.t) navigate({ t: null }, { push: false })
    else navigate({ s: null, t: null, tab: 'inbox' }, { push: false })
  }
  const inThread = route.tab === 'inbox' && !!route.t
  // Typing in the terminal: the keyboard takes half the screen, so the
  // terminal takes the rest (the header and tabs come back with the keyboard down).
  const typing = keyboard && (route.tab === 'terminal' || session.kind === 'shell')
  const [shellOpen, setShellOpen] = useState(false)
  return (
    <>
      {shellOpen && session.kind !== 'shell' && session.status !== 'ended' && <PhoneShell session={session} typing={keyboard} onClose={() => setShellOpen(false)} />}
      <header className={cx('flex h-14 shrink-0 items-center gap-0.5 px-1.5', inThread && 'border-b border-line', typing && 'hidden')}>
        <button
          type="button"
          data-testid="mobile-back"
          aria-label={inThread ? 'Back to threads' : 'Back to sessions'}
          onClick={back}
          className="flex h-11 min-w-11 items-center gap-0.5 rounded-[10px] border-0 bg-transparent px-1.5 text-fg2"
        >
          <IconBack size={20} />
          {!inThread && othersWaiting > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[12px] font-extrabold text-onaccent">{othersWaiting}</span>
          )}
          {inThread && unreadElsewhere(sessionThreads, route.t) > 0 && (
            <span data-testid="back-badge" title="Other threads have new messages" className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-[12px] font-extrabold text-onaccent">
              {unreadElsewhere(sessionThreads, route.t)}
            </span>
          )}
        </button>
        {inThread ? (
          <>
            <div className="flex min-w-0 flex-1 flex-col">
              <span data-testid="phone-thread-subject" className="truncate text-[15.5px] font-[650]">
                {thread?.subject ?? '…'}
              </span>
              <span className="mono text-[11.5px] text-subtle">{session.name}</span>
            </div>
            <button
              type="button"
              aria-label="Mark unread"
              onClick={() => route.t && api.markUnread(route.t).then(back).catch(error)}
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
                    back()
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
      {session.kind !== 'shell' && !typing && <div className="mx-3 mb-2 mt-0.5 shrink-0" role="tablist">
        <Segmented
          size="lg"
          value={route.tab}
          onChange={(tab) => navigate({ tab }, { push: false })}
          testidPrefix="mobile-tab"
          options={[
            { value: 'inbox', label: 'Inbox' },
            { value: 'terminal', label: 'Terminal' },
          ]}
        />
      </div>}
      {route.tab === 'inbox' && session.kind !== 'shell' ? <InboxPhone session={session} /> : <PhoneTerminal session={session} typing={typing} />}
    </>
  )
}

/** The companion shell, full screen in front of everything. It is mounted only while shown: the shell itself lives on. */
function PhoneShell({ session, typing, onClose }: { session: Session; typing: boolean; onClose: () => void }) {
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


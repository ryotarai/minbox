import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileTree, useFileTree, useFileTreeSearch } from '@pierre/trees/react'
import type { ContextMenuItem as FileTreeContextMenuItem, ContextMenuOpenContext as FileTreeContextMenuOpenContext } from '@pierre/trees'
import { api, type FileTreeListing, type Session, type TreeFile } from '../api'
import { useApp } from '../lib/app'
import { CODE_HIGHLIGHT_MAX_CHARS, CODE_WRAP_LINE_CHARS, langOf } from './AttachmentViewer'
import { IconBack, IconCheck, IconClose, IconCopy, IconRefresh, IconWrapText } from './icons'
import { insertFileMention } from './Files'
import { cx, IconButton } from './ui'

/** How often the open pane looks for new files and git changes. */
const REFRESH_MS = 15_000

// The tree draws in a shadow root: Tailwind does not reach it, its colors come from minbox's tokens.
const TREE_STYLE: React.CSSProperties = {
  height: '100%',
  ['--trees-bg-override' as string]: 'var(--mb-bg)',
  ['--trees-fg-override' as string]: 'var(--mb-fg2)',
  ['--trees-fg-muted-override' as string]: 'var(--mb-subtle)',
  ['--trees-bg-muted-override' as string]: 'var(--mb-raised)',
  ['--trees-border-color-override' as string]: 'var(--mb-line)',
  ['--trees-accent-override' as string]: 'var(--mb-accent)',
  ['--trees-selected-bg-override' as string]: 'var(--mb-sel)',
  ['--trees-selected-fg-override' as string]: 'var(--mb-fg)',
  ['--trees-selected-focused-border-color-override' as string]: 'var(--mb-accent)',
  ['--trees-focus-ring-color-override' as string]: 'var(--mb-accent)',
  ['--trees-input-bg-override' as string]: 'var(--mb-sunken)',
  ['--trees-search-bg-override' as string]: 'var(--mb-sunken)',
  ['--trees-search-fg-override' as string]: 'var(--mb-fg)',
  ['--trees-indent-guide-bg-override' as string]: 'var(--mb-line)',
  ['--trees-scrollbar-thumb-override' as string]: 'var(--mb-linestrong)',
  ['--trees-font-family-override' as string]: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Hiragino Sans', 'Noto Sans JP', sans-serif",
  ['--trees-font-size-override' as string]: '13px',
  ['--trees-git-added-color-override' as string]: 'var(--mb-ok)',
  ['--trees-git-untracked-color-override' as string]: 'var(--mb-ok)',
  ['--trees-git-modified-color-override' as string]: 'var(--mb-wait)',
  ['--trees-git-renamed-color-override' as string]: 'var(--mb-work)',
  ['--trees-git-deleted-color-override' as string]: 'var(--mb-danger)',
  ['--trees-status-added-override' as string]: 'var(--mb-ok)',
  ['--trees-status-untracked-override' as string]: 'var(--mb-ok)',
  ['--trees-status-modified-override' as string]: 'var(--mb-wait)',
  ['--trees-status-renamed-override' as string]: 'var(--mb-work)',
  ['--trees-status-deleted-override' as string]: 'var(--mb-danger)',
}

// The Files pane (loaded on first use: @pierre/trees stays out of the main bundle).

/**
 * The thread's session folder as a file tree (@pierre/trees): type to filter by name, git's status
 * on the changed files, a click on a file shows it below (or full screen on a phone), and
 * "Insert @mention" (the viewer's button, the row menu, or @ on a row) writes its path into the
 * thread's message box. Paths are relative to the session's folder, as the @ completion writes them.
 */
export function FilesPane({ session, threadId, draftKey, phone, onClose }: { session: Session; threadId: string; /** Where @ mentions go (default: the thread's reply draft). */ draftKey?: string; phone?: boolean; onClose: () => void }) {
  const { error, threadVersion } = useApp()
  const [listing, setListing] = useState<FileTreeListing | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const selectRef = useRef<(paths: readonly string[]) => void>(() => {})
  const { model } = useFileTree({
    paths: [],
    search: true,
    fileTreeSearchMode: 'hide-non-matches',
    initialExpansion: 'closed',
    flattenEmptyDirectories: true,
    density: 'compact',
    onSelectionChange: (paths) => selectRef.current(paths),
  })
  const search = useFileTreeSearch(model)
  const pathsKey = useRef('')

  const load = useCallback(
    (manual = false) => {
      if (manual) setLoading(true)
      const sid = session.id
      Promise.all([api.tree(sid), api.treeStatus(sid).catch(() => ({ entries: [] }))])
        .then(([t, st]) => {
          setFailed(null)
          setListing(t)
          const key = t.paths.join('\n')
          if (key !== pathsKey.current) {
            // Keep the folders that are open across a reload.
            const expanded: string[] = []
            if (pathsKey.current) {
              const dirs = new Set<string>()
              for (const p of pathsKey.current.split('\n')) {
                const parts = p.replace(/\/$/, '').split('/')
                for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/')
                if (p.endsWith('/')) dirs.add(p)
              }
              for (const d of dirs) {
                const it = model.getItem(d)
                if (it && it.isDirectory() && 'isExpanded' in it && it.isExpanded()) expanded.push(d)
              }
            }
            pathsKey.current = key
            model.resetPaths(t.paths, { initialExpandedPaths: expanded })
          }
          model.setGitStatus(st.entries)
        })
        .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
        .finally(() => manual && setLoading(false))
    },
    [session.id, model],
  )
  // On open, every REFRESH_MS while the page is shown, and when the thread moves (the agent wrote).
  useEffect(() => {
    load()
    const t = setInterval(() => document.visibilityState === 'visible' && load(), REFRESH_MS)
    return () => clearInterval(t)
  }, [load])
  const tv = threadVersion[threadId] ?? 0
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const t = setTimeout(() => load(), 400)
    return () => clearTimeout(t)
  }, [tv, load])

  selectRef.current = (paths) => {
    const p = paths.length === 1 ? paths[0]! : null
    if (!p) return
    const it = model.getItem(p)
    if (it && !it.isDirectory()) setOpen(p)
  }
  const closeFile = () => {
    if (open) model.getItem(open)?.deselect()
    setOpen(null)
  }
  const insert = (p: string) => {
    if (phone) onClose()
    insertFileMention(draftKey ?? threadId, p)
  }

  // Keys typed in the tree (its search box, type-ahead, arrows) stay there: the thread's single-key
  // shortcuts (E, J, K…) must not see them. @ on a row inserts that row's path; ⌘ combinations pass.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return
    const inner = e.nativeEvent.composedPath()[0] as HTMLElement | undefined
    const typing = inner instanceof HTMLInputElement || inner instanceof HTMLTextAreaElement
    if (e.key === '@' && !typing) {
      const p = model.getFocusedPath()
      if (p) {
        e.preventDefault()
        insert(p)
      }
    }
    e.stopPropagation()
  }

  const renderMenu = (item: FileTreeContextMenuItem, ctx: FileTreeContextMenuOpenContext) => {
    const path = item.kind === 'directory' && !item.path.endsWith('/') ? `${item.path}/` : item.path
    const run = (fn: () => void) => () => {
      ctx.close({ restoreFocus: false })
      fn()
    }
    const r = ctx.anchorRect
    return (
      <div
        role="menu"
        data-testid="files-row-menu"
        data-file-tree-context-menu-root="true"
        style={{ position: 'fixed', top: r.bottom + 2, left: Math.max(8, r.right - 200), zIndex: 60 }}
        className="flex w-[200px] flex-col rounded-lg border border-linestrong bg-overlay p-1 text-[13px] shadow-pop"
      >
        {item.kind === 'file' && (
          <MenuButton testid="files-menu-open" onClick={run(() => setOpen(item.path))}>
            Open
          </MenuButton>
        )}
        <MenuButton testid="files-menu-mention" onClick={run(() => insert(path))}>
          Insert @mention
        </MenuButton>
        <MenuButton testid="files-menu-copy" onClick={run(() => void navigator.clipboard?.writeText(path).catch(error))}>
          Copy path
        </MenuButton>
      </div>
    )
  }

  const count = listing?.paths.length ?? 0
  const header = (
    <div className={cx('flex shrink-0 items-center gap-1.5 border-b border-line', phone ? 'h-14 px-1.5' : 'h-11 pl-3.5 pr-1.5')}>
      {phone && (
        <IconButton aria-label={open ? 'Back to the files' : 'Back to the thread'} data-testid="files-back" onClick={open ? closeFile : onClose}>
          <IconBack />
        </IconButton>
      )}
      <h2 className={cx('m-0 font-[650] text-fg', phone ? 'text-[16px]' : 'text-[13.5px]')}>Files</h2>
      <span data-testid="files-root" title={session.cwd} className="mono min-w-0 flex-1 truncate text-[11.5px] text-subtle">
        {session.cwd.replace(/^\/(Users|home)\/[^/]+/, '~')}
      </span>
      <IconButton aria-label="Refresh" title="Refresh: files and git status" data-testid="files-refresh" size={28} onClick={() => load(true)} className={loading ? 'animate-pulse' : undefined}>
        <IconRefresh size={14} />
      </IconButton>
      {!phone && (
        <IconButton aria-label="Hide files" title="Hide files (⇧F)" data-testid="files-close" size={28} onClick={onClose}>
          <IconClose size={14} />
        </IconButton>
      )}
    </div>
  )

  const viewer = open && <FileViewer key={open} sessionId={session.id} path={open} phone={!!phone} onClose={closeFile} onMention={() => insert(open)} />
  return (
    <aside data-testid="files-pane" data-session-id={session.id} aria-label="Files" className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      {header}
      {failed && (
        <div data-testid="files-error" className="px-3.5 py-2 text-[12.5px] leading-[1.5] text-danger">
          {failed}
        </div>
      )}
      {listing?.truncated && (
        <div data-testid="files-truncated" className="px-3.5 py-1.5 text-[12px] text-subtle">
          Showing the first {count.toLocaleString()} files.
        </div>
      )}
      <div className={cx('relative min-h-0', open ? (phone ? 'hidden' : 'basis-[40%] border-b border-line') : 'flex-1')} onKeyDown={onKeyDown}>
        {listing && count === 0 && !search.value && (
          <div data-testid="files-empty" className="absolute inset-x-0 top-10 px-3.5 text-[12.5px] text-subtle">
            No files here.
          </div>
        )}
        {!listing && !failed && <div className="px-3.5 py-2 text-[12.5px] text-subtle">Loading…</div>}
        <FileTree model={model} data-testid="files-tree" style={TREE_STYLE} renderContextMenu={renderMenu} />
      </div>
      {viewer && <div className={cx('flex min-h-0 flex-col', phone ? 'flex-1' : 'basis-[60%] grow')}>{viewer}</div>}
    </aside>
  )
}

function MenuButton({ testid, onClick, children }: { testid: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="menuitem" data-testid={testid} onClick={onClick} className="rounded-md border-0 bg-transparent px-2.5 py-1.5 text-left text-fg hover:bg-raised focus:bg-raised focus:outline-none">
      {children}
    </button>
  )
}

type Tok = { content: string; color?: string }

/** The viewer's word-wrap choice, kept across files and reloads (this browser only). */
const WRAP_KEY = 'minbox:files-wrap'
function readWrap(): boolean | null {
  try {
    const v = localStorage.getItem(WRAP_KEY)
    return v === null ? null : v === '1'
  } catch {
    return null
  }
}
function writeWrap(v: boolean) {
  try {
    localStorage.setItem(WRAP_KEY, v ? '1' : '0')
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

function sizeLabel(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** One file of the tree: text highlighted with shiki (as the attachment viewer does), an image, or why not. */
function FileViewer({ sessionId, path, phone, onClose, onMention }: { sessionId: string; path: string; phone: boolean; onClose: () => void; onMention: () => void }) {
  const [file, setFile] = useState<TreeFile | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tokens, setTokens] = useState<Tok[][] | null>(null)
  const { error } = useApp()
  const [copied, setCopied] = useState(false)
  const [wrapPref, setWrapPref] = useState<boolean | null>(readWrap)
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(copiedTimer.current), [])
  // Copies the text already loaded for the viewer; a brief check says it worked.
  const copy = () => {
    if (file?.kind !== 'text') return
    const clip = navigator.clipboard
    if (!clip) return error('The clipboard is not available here')
    clip
      .writeText(file.text ?? '')
      .then(() => {
        setCopied(true)
        clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch(error)
  }
  useEffect(() => {
    let live = true
    api
      .treeFile(sessionId, path)
      .then((f) => live && setFile(f))
      .catch((e: unknown) => live && setErr(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [sessionId, path])
  const text = file?.kind === 'text' ? (file.text ?? '') : ''
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text])
  useEffect(() => {
    setTokens(null)
    if (!text || text.length > CODE_HIGHLIGHT_MAX_CHARS) return
    let live = true
    const dark = document.documentElement.dataset.theme !== 'light'
    import('shiki')
      .then(async ({ codeToTokens, bundledLanguages }) => {
        const lang = langOf(path.split('/').pop() ?? path)
        const r = await codeToTokens(text.replace(/\n$/, ''), { lang: (lang in bundledLanguages ? lang : 'text') as never, theme: dark ? 'github-dark' : 'github-light' })
        if (live) setTokens(r.tokens.map((l) => l.map((t) => ({ content: t.content, color: t.color }))))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [text, path])
  // Word wrap: the viewer's toggle; with no choice made yet, only files with huge lines wrap.
  const wrap = wrapPref ?? lines.some((l) => l.length > CODE_WRAP_LINE_CHARS)
  const toggleWrap = () => {
    setWrapPref(!wrap)
    writeWrap(!wrap)
  }
  const slash = path.lastIndexOf('/') + 1
  const note = (s: string) => (
    <div data-testid="file-viewer-note" className="px-3.5 py-3 text-[12.5px] leading-[1.5] text-subtle">
      {s}
    </div>
  )
  return (
    <section data-testid="file-viewer" data-path={path} aria-label={path} className="flex min-h-0 flex-1 flex-col">
      <div className={cx('flex shrink-0 items-center gap-1.5 border-b border-line', phone ? 'h-11 px-3' : 'h-9 pl-3.5 pr-1.5')}>
        <span data-testid="file-viewer-path" title={path} className="mono min-w-0 flex-1 truncate text-[12px]">
          <span className="text-subtle">{path.slice(0, slash)}</span>
          <span className="text-fg">{path.slice(slash)}</span>
        </span>
        {file && <span className="shrink-0 text-[11.5px] text-faint">{sizeLabel(file.size)}</span>}
        <button
          type="button"
          data-testid="file-viewer-mention"
          title="Insert @mention into the message box (@ on a row does the same)"
          onClick={onMention}
          className="mono shrink-0 rounded-md border border-linestrong bg-transparent px-1.5 py-0.5 text-[12px] text-fg2 hover:bg-raised hover:text-fg"
        >
          @
        </button>
        {file?.kind === 'text' && (
          <IconButton
            aria-label="Word wrap"
            title={wrap ? 'Word wrap: on' : 'Word wrap: off'}
            aria-pressed={wrap}
            data-testid="file-viewer-wrap"
            size={phone ? 32 : 26}
            onClick={toggleWrap}
            className={wrap ? 'bg-raised text-fg' : undefined}
          >
            <IconWrapText size={14} />
          </IconButton>
        )}
        {file?.kind === 'text' && (
          <IconButton
            aria-label={copied ? 'Copied' : 'Copy contents'}
            title={copied ? 'Copied' : 'Copy contents'}
            data-testid="file-viewer-copy"
            data-copied={copied || undefined}
            size={phone ? 32 : 26}
            onClick={copy}
            className={copied ? 'text-ok' : undefined}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </IconButton>
        )}
        {!phone && (
          <IconButton aria-label="Close file" title="Close file" data-testid="file-viewer-close" size={26} onClick={onClose}>
            <IconClose size={14} />
          </IconButton>
        )}
      </div>
      <div data-testid="file-viewer-scroll" className="min-h-0 flex-1 overflow-auto">
        {err && note(err)}
        {!file && !err && note('Loading…')}
        {file?.kind === 'binary' && note(`A binary file (${sizeLabel(file.size)}): nothing to show.`)}
        {file?.kind === 'too_large' && note(`Too large to show here (${sizeLabel(file.size)}).`)}
        {file?.kind === 'hidden' && note('.env files are not shown (they hold secrets).')}
        {file?.kind === 'image' && (
          <div className="p-3">
            <img data-testid="file-viewer-image" src={api.treeRawUrl(sessionId, path)} alt={path} className="max-w-full rounded-md border border-line bg-[repeating-conic-gradient(var(--mb-raised)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]" />
          </div>
        )}
        {file?.kind === 'text' && (
          <div data-testid="file-viewer-code" data-wrap={wrap || undefined} className={cx('mono py-1.5 text-[12px] leading-[1.65]', !wrap && 'min-w-max')}>
            {lines.map((l, i) => (
              <div key={i} className="flex">
                <span className="w-11 shrink-0 select-none pr-3 text-right text-faint">{i + 1}</span>
                <span className={cx('pr-3 text-fg2', wrap ? 'min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre')}>
                  {tokens?.[i]
                    ? tokens[i]!.map((t, j) => (
                        <span key={j} style={{ color: t.color }}>
                          {t.content}
                        </span>
                      ))
                    : l || ' '}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { api, type AttachmentDetail, type ReviewFile } from '../api'
import { useApp } from '../lib/app'
import { updateReplyDraft, useReplyDraft } from '../lib/drafts'
import { hm, plural } from '../lib/format'
import { useHotkeys } from '../lib/hotkeys'
import { IconBack, IconClose } from './icons'
import { Button, IconButton, Segmented, cx } from './ui'
import { useThread } from './ThreadView'

type Row = { kind: 'ctx' | 'add' | 'del' | 'hunk'; old?: number; new?: number; text: string }

/** Parses a unified diff into rows with old and new line numbers. */
export function parseDiff(diff: string): Row[] {
  const rows: Row[] = []
  let o = 0
  let n = 0
  for (const line of diff.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
    if (h) {
      o = Number(h[1])
      n = Number(h[2])
      rows.push({ kind: 'hunk', text: line })
      continue
    }
    if (line.startsWith('+')) rows.push({ kind: 'add', new: n++, text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ kind: 'del', old: o++, text: line.slice(1) })
    else if (line.startsWith('\\')) continue
    else if (rows.length > 0) rows.push({ kind: 'ctx', old: o++, new: n++, text: line.slice(1) })
  }
  while (rows.length && rows[rows.length - 1]!.kind === 'ctx' && rows[rows.length - 1]!.text === '') rows.pop()
  return rows
}

function useReviewed(id: string): [Set<number>, (i: number) => void] {
  const key = `minbox:reviewed:${id}`
  const [set, setSet] = useState<Set<number>>(() => new Set(JSON.parse(localStorage.getItem(key) ?? '[]') as number[]))
  const toggle = (i: number) =>
    setSet((p) => {
      const n = new Set(p)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      localStorage.setItem(key, JSON.stringify([...n]))
      return n
    })
  return [set, toggle]
}

/** A guided review, full screen: sections with their diffs, comments on lines. */
export function GuidedReview({ attachmentId }: { attachmentId: string }) {
  const { navigate, error, sessions } = useApp()
  const [d, setD] = useState<AttachmentDetail | null>(null)
  const [mode, setMode] = useState<'split' | 'unified'>('split')
  const [openSec, setOpenSec] = useState(0)
  const [file, setFile] = useState<{ sec: number; i: number }>({ sec: 0, i: 0 })
  const [reviewed, toggleReviewed] = useReviewed(attachmentId)
  useEffect(() => {
    api
      .attachment(attachmentId)
      .then((v) => {
        setD(v)
        // Start at the section the summary points at, else the first not reviewed.
        const first = v.review?.sections.findIndex((_, i) => !reviewed.has(i)) ?? 0
        setOpenSec(Math.max(0, first))
        setFile({ sec: Math.max(0, first), i: 0 })
      })
      .catch(error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachmentId, error])

  const close = () => navigate({ view: 'main', r: null, ...(d ? { t: d.thread_id } : {}) })
  useHotkeys({ escape: close })

  const r = d?.review
  const [thread] = useThread(d?.thread_id ?? null)
  const session = sessions?.find((s) => s.id === thread?.session_id) ?? null
  const fileCount = r?.sections.reduce((n, s) => n + s.files.length, 0) ?? 0
  const cur: ReviewFile | undefined = r?.sections[file.sec]?.files[file.i]

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-bg" data-testid="guided-review">
      <div className="flex h-12 shrink-0 items-center gap-3.5 border-b border-line bg-surface pl-4 pr-3">
        <button type="button" onClick={close} className="flex h-8 items-center gap-1.5 border-0 bg-transparent text-[13px] text-fg2 hover:text-fg" data-testid="review-back">
          <IconBack size={14} /> Thread
        </button>
        <span aria-hidden="true" className="h-5 w-px bg-line2" />
        <span className="text-[14px] font-[650]">Guided review</span>
        {d && (
          <span className="hidden text-[12.5px] text-subtle sm:inline">
            from Claude Code{session ? ` in ${session.name}` : ''}, sent {hm(d.created_at)}
          </span>
        )}
        <span className="flex-1" />
        <Segmented
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'split', label: 'Split' },
            { value: 'unified', label: 'Unified' },
          ]}
        />
        <IconButton aria-label="Close" onClick={close}>
          <IconClose />
        </IconButton>
      </div>

      {!r ? (
        <div className="p-10 text-[13px] text-subtle">{d ? 'This attachment has no review.' : 'Loading…'}</div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5 px-10 pb-3.5 pt-6">
            <h1 className="m-0 text-[24px] font-bold">{r.title || d!.name}</h1>
            {r.summary && <p className="m-0 max-w-[820px] text-[14px] leading-[1.6] text-muted">{r.summary}</p>}
            <span className="mono text-[12px] text-subtle">
              {plural(r.sections.length, 'section')} · {plural(fileCount, 'file')} · <span className="text-ok">+{r.additions}</span> <span className="text-danger">−{r.deletions}</span> ·{' '}
              <span className="text-fg2">
                {reviewed.size} / {r.sections.length} reviewed
              </span>
            </span>
          </div>
          <div className="mx-10 mb-7 flex min-h-0 flex-1 overflow-hidden rounded-[14px] border border-line bg-carddim">
            <aside className="flex w-[380px] shrink-0 flex-col gap-3.5 overflow-y-auto border-r border-line p-[22px]">
              {r.sections.map((s, si) => {
                const isOpen = si === openSec
                return (
                  <div key={si} className="flex flex-col gap-2 border-b border-[#1f1f24] pb-3.5" data-testid="review-section">
                    <button type="button" onClick={() => setOpenSec(isOpen ? -1 : si)} className="flex items-center gap-2 border-0 bg-transparent p-0 text-left">
                      <span className={cx('flex-1 text-[15px]', isOpen ? 'font-[650] text-fg' : 'text-muted')}>{s.title}</span>
                      <span className="text-subtle">{isOpen ? '⌃' : '⌄'}</span>
                    </button>
                    <label className="flex items-center gap-2 text-[12.5px] text-muted">
                      <span className="mono">
                        {String(si + 1).padStart(2, '0')} / {String(r.sections.length).padStart(2, '0')}
                      </span>
                      <input type="checkbox" checked={reviewed.has(si)} onChange={() => toggleReviewed(si)} data-testid="review-reviewed" className="accent-[var(--mb-muted)]" />
                      Reviewed
                    </label>
                    {isOpen && (
                      <>
                        {s.summary && <p className="m-0 text-[13.5px] leading-[1.65] text-fg2">{s.summary}</p>}
                        <div className="flex flex-col gap-1.5">
                          {s.files.map((f, fi) => {
                            const sel = file.sec === si && file.i === fi
                            const parts = f.path.split('/')
                            return (
                              <button
                                key={f.path}
                                type="button"
                                onClick={() => setFile({ sec: si, i: fi })}
                                className={cx('mono flex h-10 items-center gap-2 rounded-lg border bg-sunken px-3 text-left text-[12.5px]', sel ? 'border-accent' : 'border-transparent')}
                              >
                                <b className="font-semibold">{parts.pop()}</b>
                                <span className="truncate text-subtle">{parts.join('/')}</span>
                                <span className="flex-1" />
                                {f.additions > 0 && <span className="text-ok">+{f.additions}</span>}
                                {f.deletions > 0 && <span className="text-danger">−{f.deletions}</span>}
                              </button>
                            )
                          })}
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </aside>
            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-[26px] py-[22px]">
              {cur ? (
                <>
                  {r.sections[file.sec]?.summary && <p className="m-0 text-[14px] text-body">{r.sections[file.sec]!.summary.split('\n')[0]}</p>}
                  <div className="mono text-[13px]">
                    {cur.path.includes('/') && <span className="text-muted">{cur.path.split('/').slice(0, -1).join('/')}/</span>}
                    <b className="font-semibold">{cur.path.split('/').pop()}</b> <span className="text-ok">+{cur.additions}</span> <span className="text-danger">−{cur.deletions}</span>
                  </div>
                  <DiffView file={cur} mode={mode} attachmentId={attachmentId} threadId={d!.thread_id} />
                </>
              ) : (
                <span className="text-[13px] text-subtle">No files in this section.</span>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function DiffView({ file, mode, attachmentId, threadId }: { file: ReviewFile; mode: 'split' | 'unified'; attachmentId: string; threadId: string }) {
  const rows = useMemo(() => parseDiff(file.diff), [file.diff])
  const draft = useReplyDraft(threadId)
  const comments = draft.annotations.filter((a) => a.attachment_id === attachmentId && a.name === file.path)
  const [editing, setEditing] = useState<number | null>(null)
  const [text, setText] = useState('')
  const save = (row: Row) => {
    if (!text.trim()) return
    updateReplyDraft(threadId, (d) => ({
      ...d,
      annotations: [...d.annotations, { kind: 'comment', attachment_id: attachmentId, name: file.path, line: row.new ?? row.old, quote: row.text.trim().slice(0, 200), comment: text.trim() }],
    }))
    setText('')
    setEditing(null)
  }
  if (!file.diff.trim()) return <div className="text-[13px] text-subtle">No changes in this file.</div>
  return (
    <div className="mono overflow-x-auto rounded-[10px] border border-line bg-sunken text-[12.5px] leading-[1.75]" data-testid="diff">
      {rows.map((row, i) => {
        if (row.kind === 'hunk') return <div key={i} className="bg-[#141417] px-4 py-1 text-subtle [[data-theme=light]_&]:bg-raised">{row.text}</div>
        const line = row.new ?? row.old
        const bg = row.kind === 'add' ? 'bg-ok/10 shadow-[inset_3px_0_0_var(--mb-ok)]' : row.kind === 'del' ? 'bg-danger/12 shadow-[inset_3px_0_0_var(--mb-danger)]' : ''
        const here = comments.filter((c) => c.line === line && c.quote === row.text.trim().slice(0, 200))
        return (
          <div key={i}>
            <div className={cx('group flex cursor-default', bg)} onClick={() => setEditing(i)} data-testid="diff-line">
              {mode === 'split' ? (
                <>
                  <span className="w-[52px] shrink-0 pr-3.5 text-right text-faint">{row.old ?? ''}</span>
                  <span className="w-[52px] shrink-0 pr-3.5 text-right text-faint">{row.new ?? ''}</span>
                </>
              ) : (
                <span className="w-[52px] shrink-0 pr-3.5 text-right text-faint">{line}</span>
              )}
              <span className="w-4 shrink-0 text-subtle">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
              <span className="whitespace-pre text-[#d4d4d8] [[data-theme=light]_&]:text-fg2">{row.text}</span>
              <span className="ml-auto hidden pr-3 text-subtle group-hover:inline">💬</span>
            </div>
            {here.map((c, ci) => (
              <div key={ci} className="my-1.5 ml-[66px] mr-4 flex flex-col gap-1.5 rounded-[10px] border border-[#3a3a42] bg-overlay px-3 py-2.5 font-sans">
                <span className="text-[12px]">
                  <b className="font-[650] text-wait">Comment</b> <span className="text-subtle">you · line {c.line}</span>
                </span>
                <span className="text-[13px]">{c.comment}</span>
              </div>
            ))}
            {editing === i && (
              <div className="my-1.5 ml-[66px] mr-4 flex flex-col gap-2 rounded-[10px] border border-accent bg-overlay p-2.5 font-sans" onClick={(e) => e.stopPropagation()}>
                <textarea
                  autoFocus
                  aria-label="Comment on this line"
                  data-testid="diff-comment"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save(row)
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setEditing(null)
                    }
                  }}
                  className="h-16 resize-none border-0 bg-transparent text-[13px] text-fg outline-none"
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" onClick={() => save(row)} disabled={!text.trim()}>
                    Save
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

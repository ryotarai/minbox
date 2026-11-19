// The v3 reply box (the thread view's reply box before v3, in a stream or a task): the words are a
// draft (lib/drafts: survives navigation and reload, and the Files pane's @ mention, a quote and a
// cancelled message land in it), files (paperclip, paste, drop, a long paste becomes a file; a
// drawing), @ completes the agent's files, "!" runs a command, the picked answers to the
// conversation's questions and the viewer's comments go with the words, the reply help's questions,
// and, to an agent that ended, where the reply should go (resume it, another agent, or keep it).
// A task's box can also send without the task (a quieter second button, ⇧⌘↵): to an agent's stream,
// untagged, as its stream's box does.
import { useLayoutEffect, useRef, useState } from 'react'
import type { Annotation, Answer, Session } from '../api'
import { useApp } from '../lib/app'
import { getReplyDraft, updateReplyDraft, useDraftsVersion, useReplyDraft } from '../lib/drafts'
import { ComposeFileTiles, clearFiles, fileInputHandlers, uploadIds, useComposeFiles } from '../lib/uploads'
import { isMac, plural } from '../lib/format'
import { SketchButton } from '../components/Sketch'
import { useMentions } from '../components/Mentions'
import { commandOf } from '../components/CommandMessage'
import { ReplyHelpPanel, useReplyHelp, withReplyHelp } from '../components/ReplyHelp'
import { IconCheck, IconClose, IconComment, IconExpand, IconPaperclip, IconPlus, IconSketch } from '../components/icons'
import { Popover } from '../components/ui'
import { v3, type Task, type V3Message } from './data'
import { TaskChip, TaskPicker, agentHint, clearAnswers, draftedAnswers, openQuestions, useAnswersVersion } from './parts'
import { useQuoteTarget } from './quote'

/** What the composer sends: the words, the recipient, more tasks it is about, the uploaded files,
 *  the answers that go with the words, the viewer's comments, and where an ended agent's reply goes. */
export type Outgoing = {
  words: string
  to: string
  tasks: string[]
  uploads: string[]
  answers_for?: string
  answers?: Answer[]
  annotations?: Annotation[]
  resume?: boolean
  forward_to?: string
}

export function Composer({
  toId,
  toOptions,
  onTo,
  about,
  placeholder,
  onSend,
  draftKey,
  testid = 'composer',
  tasks,
  messages = [],
  annotationKeys = [],
  helpThread,
  helpTask,
  compact = false,
  untagged,
}: {
  toId: string
  toOptions: Session[]
  onTo?: (id: string) => void
  /** The task the message is about from where it is written (a task's view): always (one at most). */
  about: { task_id: string; title: string }[]
  placeholder: string
  onSend: (o: Outgoing) => Promise<void>
  /** Where the words and the attached files are kept until sent (the stream's thread / the task). */
  draftKey: string
  testid?: string
  /** The tasks the person can pick the message's one task from (the task button), where none is given. */
  tasks?: Task[]
  /** The conversation on screen: the picked answers to its questions go with Send. */
  messages?: V3Message[]
  /** Drafts (thread ids) whose comments on files (the attachment viewer's) go with the reply. */
  annotationKeys?: string[]
  /** The stream's thread: the reply help's questions for the agent's last message. */
  helpThread?: string
  /** A task's view: the reply help's questions for the task's latest agent message (kept by the task). */
  helpTask?: string
  /** A small box (the Tasks pane's): one line growing to a few, no full height. */
  compact?: boolean
  /** A task's box: the second, quieter send (⇧⌘↵) that sends to this agent's stream without the task. */
  untagged?: { to: string; onSend: (o: Outgoing) => Promise<void> }
}) {
  const { isPhone, settings, toast, sessions } = useApp()
  const draft = useReplyDraft(draftKey)
  useDraftsVersion()
  useAnswersVersion()
  const words = draft.words
  const setWords = (f: (w: string) => string) => updateReplyDraft(draftKey, (d) => ({ ...d, words: f(d.words) }))
  const [busy, setBusy] = useState(false)
  const [extra, setExtra] = useState<{ task_id: string; title: string }[]>([])
  const [picking, setPicking] = useState(false)
  const [full, setFull] = useState(false)
  const [where, setWhere] = useState<{ at: HTMLElement; untagged: boolean } | null>(null)
  const [menu, setMenu] = useState<HTMLElement | null>(null)
  const compose = useComposeFiles(draftKey)
  const { files, addFiles, addPastedText, remove } = compose
  const fileInput = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const sendRef = useRef<HTMLButtonElement>(null)
  const plainRef = useRef<HTMLButtonElement>(null)
  const sketchOpen = useRef<(() => void) | null>(null)
  useQuoteTarget(setWords, box)
  const io = fileInputHandlers(addFiles, addPastedText)
  const target = toOptions.find((a) => a.id === toId) ?? (sessions ?? []).find((a) => a.id === toId)
  const cmd = commandOf(words.trim())

  // The picked answers of the conversation's questions: the newest message of the recipient's stream
  // with picks goes with the words (one message); the others go first, each on its own.
  const picked = messages.filter((m) => m.author === 'agent' && !m.pending).map((m) => ({ m, answers: draftedAnswers(m) })).filter((x) => x.answers.length > 0)
  const withWordsFor = (to: string) => [...picked].reverse().find((x) => !x.m.segment && x.m.session_id === to)
  const picksCount = picked.reduce((n, x) => n + x.answers.length, 0)
  const openCount = messages.reduce((n, m) => n + (m.author === 'agent' ? openQuestions(m).length : 0), 0)
  const annoKeys = [...new Set([draftKey, ...annotationKeys])]
  const annos = annoKeys.flatMap((k) => getReplyDraft(k).annotations)

  // Questions that help the person reply: the agent spoke last (in its stream, or about the task) and
  // asked nothing. minbox's own requests to the agent (to place messages in tasks, a goal's "continue")
  // do not count: the agent's message before them is the one to reply to (as on the server).
  const last = [...messages].reverse().find((m) => !m.pending && m.kind !== ('place' as string) && m.kind !== ('continue' as string) && m.kind !== 'run_result')
  const helpOn = helpTask ? true : !!helpThread && !last?.segment
  // Commands waiting for Allow or Deny are what the person answers first: no reply help meanwhile.
  const commandsWaiting = messages.some((m) => m.run_commands?.some((c) => c.state === 'pending'))
  const wantHelp = helpOn && settings.reply_suggestions && last?.author === 'agent' && openCount === 0 && !commandsWaiting && target?.status !== 'ended'
  // A task's help: its answers are kept by the task.
  const help = useReplyHelp(
    (helpTask ? last?.thread_id : helpThread) || '_',
    last?.id,
    !!wantHelp,
    helpTask ? { key: 'v3:task:' + helpTask, fetch: () => v3.taskSuggestions(helpTask) } : {},
  )
  const helpText = cmd || !wantHelp ? '' : help.text

  const uploading = files.some((f) => f.state === 'uploading')
  const ready = files.some((f) => f.state === 'done')
  const canSend = (!!words.trim() || ready || !!helpText || (!cmd && (picksCount > 0 || annos.length > 0))) && !uploading && !busy

  const send = async (opts: { resume?: boolean; forward_to?: string; keep?: boolean; untagged?: boolean } = {}) => {
    if (!canSend) return
    const plain = !!opts.untagged && !!untagged
    const dest = plain ? untagged!.to : toId
    const deliver = plain ? untagged!.onSend : onSend
    const destSess = plain ? (sessions ?? []).find((s) => s.id === dest) : target
    console.log('DBGSEND', JSON.stringify(opts), plain, dest, destSess?.status)
    if (destSess?.status === 'ended' && !opts.resume && !opts.forward_to && !opts.keep) {
      const at = plain ? plainRef.current : sendRef.current
      if (at) setWhere({ at, untagged: plain })
      return
    }
    const withWords = withWordsFor(dest)
    const alone = picked.filter((x) => x !== withWords)
    setBusy(true)
    const w = words.trim()
    const ex = extra
    try {
      if (cmd) {
        // A "!command" goes alone: the answers and files stay for the next message.
        updateReplyDraft(draftKey, (d) => ({ ...d, words: '' }))
        await deliver({ words: w, to: dest, tasks: plain ? [] : ex.map((t) => t.task_id), uploads: [], resume: opts.resume, forward_to: opts.forward_to })
      } else {
        for (const x of alone) {
          await v3.send(x.m.session_id, { words: '', answers_for: x.m.id, answers: x.answers }, x.m.thread_id)
          clearAnswers(x.m.id)
        }
        const text = withReplyHelp(helpText, w)
        const ups = uploadIds(draftKey)
        if (text || withWords || annos.length || ups.length) {
          updateReplyDraft(draftKey, (d) => ({ ...d, words: '' }))
          setExtra([])
          await deliver({
            words: text,
            to: dest,
            tasks: plain ? [] : ex.map((t) => t.task_id),
            uploads: ups,
            answers_for: withWords?.m.id,
            answers: withWords?.answers,
            annotations: annos.length ? annos : undefined,
            resume: opts.resume,
            forward_to: opts.forward_to,
          })
          if (withWords) clearAnswers(withWords.m.id)
          clearFiles(draftKey)
          for (const k of annoKeys) updateReplyDraft(k, (d) => ({ ...d, annotations: [] }))
          if (wantHelp) help.clear()
        }
      }
      if (full) setFull(false)
      if (opts.forward_to) toast(`Sent to ${(sessions ?? []).find((s) => s.id === opts.forward_to)?.name ?? 'the other agent'}`)
    } catch (e) {
      // The words come back (the send failed: nothing was lost).
      if (w) updateReplyDraft(draftKey, (d) => ({ ...d, words: d.words.trim() ? d.words : w }))
      setExtra(ex)
      void e
    } finally {
      setBusy(false)
    }
  }

  const all = [...about, ...extra]
  const putBack = (f: (typeof files)[number]) => {
    if (!f.pasted) return
    const at = Math.min(f.pasted.at, words.length)
    setWords((t) => t.slice(0, at) + f.pasted!.text + t.slice(at))
    remove(f.key)
  }

  // The box grows with the text (up to a limit); full height fills the column instead.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (full) {
      el.style.height = ''
      el.style.overflowY = ''
      return
    }
    const max = compact ? 112 : isPhone ? 160 : 240
    el.style.height = 'auto'
    el.style.height = `${Math.min(max, Math.max(isPhone || compact ? 0 : 38, el.scrollHeight))}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [words, full, isPhone, compact])

  const mention = useMentions({
    sessionId: target && toId !== 'new' ? toId : null,
    value: words,
    onChange: (v) => setWords(() => v),
    inputRef: box,
    agents: false,
  })

  const actionKeys = new Set(messages.flatMap((m) => (m.questions ?? []).filter((q) => q.kind === 'action').map((q) => q.key)))
  const actionsDone = picked.reduce((n, x) => n + x.answers.filter((a) => actionKeys.has(a.key)).length, 0)
  const idleOthers = (sessions ?? []).filter((s) => s.id !== toId && s.status !== 'ended' && !s.archived_at && s.kind !== 'shell' && (!target?.project_id || s.project_id === target.project_id))
  const name = target?.name ?? 'the agent'
  const whereSess = where?.untagged && untagged ? (sessions ?? []).find((s) => s.id === untagged.to) : target
  const whereName = whereSess?.name ?? 'the agent'
  const plainName = untagged ? ((sessions ?? []).find((s) => s.id === untagged.to)?.name ?? 'the agent') : ''
  const plainKey = isMac() ? '⇧⌘↵' : 'Shift+Ctrl+Enter'

  return (
    <div className={'v-composer' + (full ? ' full' : '') + (compact ? ' compact' : '')} data-testid={testid} onDragOver={io.onDragOver} onDrop={io.onDrop}>
      {wantHelp && (
        <ReplyHelpPanel help={help} phone={isPhone} onSubmit={() => void send()} />
      )}
      <div className="v-to">
        to{' '}
        {onTo ? (
          <select className="v-chip" aria-label="To" data-testid="composer-to" value={toId} onChange={(e) => onTo(e.target.value)}>
            {toOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {agentHint(toOptions, a) ? ` (${agentHint(toOptions, a)})` : ''}
                {a.status === 'working' ? ' · working' : a.status === 'ended' ? ' · ended' : ''}
              </option>
            ))}
            <option value="new">New agent…</option>
          </select>
        ) : (
          <span className="v-chip">{name}</span>
        )}
        {all.length > 0 && (
          <>
            <span>about</span>
            {about.map((t) => (
              <TaskChip key={t.task_id} task={t} />
            ))}
            {extra.map((t) => (
              <TaskChip key={t.task_id} task={t} onRemove={() => setExtra((x) => x.filter((y) => y.task_id !== t.task_id))} />
            ))}
          </>
        )}
        {tasks && all.length === 0 && (
          <span style={{ position: 'relative' }}>
            <button type="button" className="v-addtask" data-testid="composer-task" title="Say which task this is about (#)" onClick={() => setPicking(true)}>
              <IconPlus size={12} /> about a task
            </button>
            {picking && (
              <TaskPicker
                tasks={tasks}
                exclude={all.map((t) => t.task_id)}
                onClose={() => setPicking(false)}
                onPick={(r) => {
                  setPicking(false)
                  if ('task_id' in r) {
                    const t = tasks.find((x) => x.id === r.task_id)
                    if (t) setExtra([{ task_id: t.id, title: t.title }])
                  }
                }}
              />
            )}
          </span>
        )}
      </div>
      <ComposeFileTiles files={files} onRemove={remove} onPutBack={putBack} />
      <div className="v-boxwrap">
        <textarea
          ref={box}
          data-testid="composer-text"
          data-composer
          aria-label="Reply"
          rows={isPhone || compact ? 1 : 2}
          value={words}
          placeholder={target?.status === 'ended' ? `${name} has ended — resume it to deliver your reply` : placeholder}
          {...mention.handlers}
          onPaste={io.onPaste}
          onChange={(e) => {
            // # in an empty box picks a task the message is about.
            if (tasks && words === '' && e.target.value === '#') {
              setPicking(true)
              return
            }
            mention.handlers.onChange(e)
          }}
          onKeyDown={(e) => {
            // An IME's Enter confirms the composition: it never sends.
            console.log('DBGKEY', e.key, e.metaKey, e.shiftKey, e.nativeEvent.isComposing, e.keyCode, canSend, busy)
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            if (mention.onKeyDown(e)) return
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void send({ untagged: e.shiftKey && !!untagged })
            } else if (e.key === 'Escape') {
              e.stopPropagation()
              ;(e.target as HTMLElement).blur()
            }
          }}
        />
        {mention.popup(true)}
      </div>
      {cmd && (
        <div className="v-cmdhint" data-testid="command-hint" title={target?.cwd}>
          Runs as a command in {target?.cwd ?? 'the agent’s folder'}, then the agent gets the result and any lines below it. Start with \! to send the text instead.
        </div>
      )}
      {(picksCount > 0 || annos.length > 0) && (
        <div className="v-chips">
          {picksCount > 0 && (
            <span className="v-pchip" data-testid="picks-chip" title={cmd ? 'A command goes alone: the answers wait for the next message' : 'The picked answers go with Send'}>
              <IconCheck size={12} /> {plural(picksCount, 'pick')}
              {actionsDone > 0 ? ` · ${actionsDone} done` : ''}
            </span>
          )}
          {annos.length > 0 && (
            <span className="v-pchip" data-testid="annotations-chip">
              <IconComment size={12} /> {plural(annos.length, 'annotation')}
              <button type="button" aria-label="Remove annotations" title="Remove annotations" onClick={() => annoKeys.forEach((k) => updateReplyDraft(k, (d) => ({ ...d, annotations: [] })))}>
                <IconClose size={12} />
              </button>
            </span>
          )}
          {openCount > 0 && (
            <span className="v-cnt2" data-testid="answer-summary">
              {picksCount} of {openCount} answered
            </span>
          )}
        </div>
      )}
      <div className="v-tb">
        <button type="button" className="v-attach" data-testid="attach-files" aria-label={isPhone ? 'Add a photo or file' : 'Attach files'} title="Attach files (or paste / drop them)" onClick={() => fileInput.current?.click()}>
          <IconPaperclip size={16} />
          {isPhone ? <span>Photo / file</span> : null}
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="attach-input"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
        <span className="v-attach v-sketch">
          <SketchButton compose={compose} openRef={isPhone ? sketchOpen : undefined} />
        </span>
        {compact ? null : isPhone ? (
          <button type="button" className="v-attach" data-testid="reply-actions" aria-label="Reply actions" aria-haspopup="menu" title="Full height, draw" onClick={(e) => setMenu(e.currentTarget)}>
            <IconPlus size={16} />
          </button>
        ) : (
          <button type="button" className={'v-attach' + (full ? ' on' : '')} data-testid="reply-full" aria-pressed={full} aria-label={full ? 'Back to the conversation' : 'Full height'} title={full ? 'Back to the conversation' : 'Full height'} onClick={() => setFull(!full)}>
            <IconExpand size={16} />
          </button>
        )}
        <span className="v-sp" />
        {uploading && <span>uploading…</span>}
        {!uploading && words.trim() && !busy && !compact && <span className="v-hide-phone" data-testid="draft-saved">Draft saved</span>}
        {untagged && (
          <button
            type="button"
            ref={plainRef}
            className="v-btn v-plainsend"
            data-testid="composer-send-untagged"
            disabled={!canSend}
            onClick={() => void send({ untagged: true })}
            aria-label={`Send to ${plainName} without the task`}
            title={`Send to ${plainName}'s stream without tying it to this task (${plainKey})`}
          >
            {isPhone ? 'No task' : 'Send without task'}
          </button>
        )}
        <span className="v-kbd v-hide-phone">⌘↵</span>
        <button type="button" ref={sendRef} className="v-btn pri" data-testid="composer-send" disabled={!canSend} onClick={() => void send()} title={cmd ? 'Run as a command' : 'Send'}>
          {busy ? (cmd ? 'Running…' : 'Sending…') : cmd ? 'Run' : 'Send'}
        </button>
      </div>
      <Popover anchor={menu} open={!!menu} onClose={() => setMenu(null)} side="top" align="start" className="w-[240px] p-1.5">
        <button type="button" role="menuitem" className="v-menuitem" data-testid="reply-full" aria-pressed={full} onClick={() => (setMenu(null), setFull(!full))}>
          <IconExpand size={18} /> {full ? 'Back to the conversation' : 'Full height editor'}
        </button>
        <button type="button" role="menuitem" className="v-menuitem" data-testid="compose-draw" onClick={() => (setMenu(null), sketchOpen.current?.())}>
          <IconSketch size={18} /> Draw a diagram
        </button>
      </Popover>
      <Popover anchor={where?.at ?? null} open={!!where} onClose={() => setWhere(null)} side="top" align="end" className="w-[320px] p-3">
        <div className="flex flex-col gap-2" data-testid="where-reply">
          <b className="text-[13.5px] font-[650]">Where should this reply go?</b>
          <span className="text-[12.5px] text-muted">{whereName} has ended.</span>
          <button type="button" data-testid="where-resume" onClick={() => (setWhere(null), void send({ resume: true, untagged: where?.untagged }))} className="h-9 rounded-md border border-accent bg-wait/8 px-2.5 text-left text-[13px]">
            Resume {whereName} and deliver it
          </button>
          {idleOthers.filter((s) => s.id !== whereSess?.id).map((s) => (
            <button key={s.id} type="button" data-testid="where-forward" onClick={() => (setWhere(null), void send({ forward_to: s.id, untagged: where?.untagged }))} className="h-9 rounded-md border border-linestrong bg-transparent px-2.5 text-left text-[13px]">
              Send to {s.name} ({s.status})
            </button>
          ))}
          <button type="button" data-testid="where-keep" onClick={() => (setWhere(null), void send({ keep: true, untagged: where?.untagged }))} className="h-8 rounded-md border-0 bg-transparent px-2.5 text-left text-[12.5px] text-subtle hover:text-fg">
            Keep it here; it goes in after Resume
          </button>
        </div>
      </Popover>
    </div>
  )
}

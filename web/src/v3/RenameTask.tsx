// Renaming a task by hand: inline in the task view's header (double-click the title, the pencil, E / F2),
// and a dialog from the Board row's menu (⋯, right-click) or E / F2 on the focused row. The new title
// shows at once (optimistic); the server records "Renamed: old → new" in the timeline and tells the
// other views. A task the person named keeps their name: the agent's later renames are not applied.
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/app'
import { Modal, MenuItem, Popover, type MenuAt } from '../components/ui'
import { IconGoal, IconPencil } from '../components/icons'
import { v3, type Task } from './data'

/** The event that starts editing the open task view's title (E / F2, the palette). */
export const RENAME_TASK_EVENT = 'minbox:rename-task'

function clean(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ')
}

/** Saves a new title: `show` is called with it at once and with the old one again if it fails. */
export function renameTask(t: Pick<Task, 'id' | 'title'>, title: string, show: (title: string) => void, error: (e: unknown) => void, done?: () => void) {
  const v = clean(title)
  if (!v || v === t.title) return
  show(v)
  v3.patchTask(t.id, { title: v })
    .then(() => done?.())
    .catch((e) => {
      show(t.title)
      error(e)
    })
}

/** The task view's title: double-click it (or the pencil, or E / F2) to rename in place; ↵ saves, Esc cancels. */
export function TaskTitle({ t, onShow, onSaved, goal }: { t: Task; onShow: (title: string) => void; onSaved: () => void; goal?: boolean }) {
  const { error } = useApp()
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(t.title)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  const start = () => {
    cancelled.current = false
    setVal(t.title)
    setEditing(true)
  }
  useEffect(() => {
    const on = () => start()
    window.addEventListener(RENAME_TASK_EVENT, on)
    return () => window.removeEventListener(RENAME_TASK_EVENT, on)
  })
  useEffect(() => {
    if (editing) {
      input.current?.focus()
      input.current?.select()
    }
  }, [editing])
  useEffect(() => setEditing(false), [t.id])
  const save = () => {
    setEditing(false)
    if (cancelled.current) return
    renameTask(t, val, onShow, error, onSaved)
  }
  if (editing)
    return (
      <input
        ref={input}
        className="v-title-edit"
        aria-label="Task title"
        data-testid="task-title-input"
        value={val}
        maxLength={200}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            input.current?.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            cancelled.current = true
            input.current?.blur()
          }
        }}
      />
    )
  return (
    <>
      <h2 data-testid="task-title" title="Double-click to rename (E)" onDoubleClick={start}>
        {goal && <IconGoal size={14} className="v-goal" style={{ color: 'var(--mb-purple)' }} />}
        {t.title}
      </h2>
      <button type="button" className="v-btn sm v-rename" data-testid="task-rename" aria-label="Rename task" title="Rename (E)" onClick={start}>
        <IconPencil size={14} />
      </button>
    </>
  )
}

/** Rename a task from the Board (its row menu, or E / F2 on the focused row). */
export function RenameTaskDialog({ task, onClose, onShow, onSaved }: { task: Task; onClose: () => void; onShow: (title: string) => void; onSaved: () => void }) {
  const { error } = useApp()
  const [val, setVal] = useState(task.title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const save = () => {
    onClose()
    renameTask(task, val, onShow, error, onSaved)
  }
  return (
    <Modal label="Rename task" onClose={onClose} className="w-[min(480px,100%)] p-4">
      <div className="mb-2 text-[14px] font-semibold">Rename {task.kind === 'goal' ? 'goal' : 'task'}</div>
      <input
        ref={input}
        aria-label="Task title"
        data-testid="rename-task-input"
        value={val}
        maxLength={200}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            save()
          }
        }}
        className="h-8 w-full rounded-sm border border-accent bg-sunken px-2 text-[14px] text-fg outline-none"
      />
      <div className="flex items-center gap-2 pt-2 text-[11.5px] text-subtle">
        <span className="flex-1">↵ save · Esc cancel</span>
        <button type="button" className="v-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="v-btn pri" data-testid="rename-task-save" onClick={save}>
          Save
        </button>
      </div>
    </Modal>
  )
}

/** A Board row's menu (⋯ or right-click): rename, open, done / reopen. */
export function TaskRowMenu({ t, at, onClose, onRename, onOpen, onToggleDone }: { t: Task; at: MenuAt | null; onClose: () => void; onRename: () => void; onOpen: () => void; onToggleDone: () => void }) {
  const pick = (f: () => void) => () => {
    onClose()
    f()
  }
  return (
    <Popover anchor={null} at={at} open={!!at} onClose={onClose} testid="task-row-menu">
      <MenuItem testid="menu-rename-task" hint="E" onClick={pick(onRename)}>
        Rename
      </MenuItem>
      <MenuItem testid="menu-open-task" hint="↵" onClick={pick(onOpen)}>
        Open
      </MenuItem>
      <MenuItem testid="menu-done-task" hint="X" onClick={pick(onToggleDone)}>
        {t.status === 'done' ? 'Reopen' : 'Mark done'}
      </MenuItem>
    </Popover>
  )
}

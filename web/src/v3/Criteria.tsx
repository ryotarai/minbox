// A goal's "Done when" criteria, edited by the person in the task card: tick one (a click on its
// circle or text), edit its text in place (double-click, or the pencil; ↵ saves, Esc cancels, an
// emptied text deletes it), delete it (×), move it up (↑), and add one in the field below (↵ adds and
// keeps the field; a pasted list adds one per line). Every change saves the whole list (PATCH
// criteria) and shows at once; when the person ticks the last one the server marks the goal done and
// ends its run.
import { useEffect, useRef, useState } from 'react'
import { useApp } from '../lib/app'
import { IconArrowUp, IconCheck, IconPencil, IconClose } from '../components/icons'
import { v3, type Step, type Task } from './data'
import { parseCriteria } from './NewGoal'

export function CriteriaEditor({ t, reload }: { t: Task; reload: () => void }) {
  const { error } = useApp()
  const [list, setList] = useState<Step[]>(t.criteria)
  const [editing, setEditing] = useState<number | null>(null)
  const [add, setAdd] = useState('')
  const saving = useRef(0)
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The list as shown now (a delayed tick reads it then, not as it was at the click).
  const cur = useRef(list)
  cur.current = list
  // The server's list wins once no save of ours is on its way.
  useEffect(() => {
    if (saving.current === 0) setList(t.criteria)
  }, [t.criteria])
  useEffect(() => setEditing(null), [t.id])
  useEffect(() => () => clearTimeout(clickTimer.current), [])
  const save = (next: Step[]) => {
    cur.current = next
    setList(next)
    saving.current++
    v3.patchTask(t.id, { criteria: next })
      .then(() => {
        saving.current--
        reload()
      })
      .catch((e) => {
        saving.current--
        setList(t.criteria)
        error(e)
      })
  }
  const tick = (i: number) => save(cur.current.map((c, j) => (j === i ? { ...c, done: !c.done } : c)))
  const remove = (i: number) => save(list.filter((_, j) => j !== i))
  const up = (i: number) => {
    if (i <= 0) return
    const next = [...list]
    ;[next[i - 1], next[i]] = [next[i]!, next[i - 1]!]
    save(next)
  }
  const edit = (i: number, text: string) => {
    setEditing(null)
    const v = text.split(/\s+/).filter(Boolean).join(' ')
    if (!v) return remove(i)
    if (v !== list[i]?.text) save(list.map((c, j) => (j === i ? { ...c, text: v } : c)))
  }
  const addAll = (text: string) => {
    const items = parseCriteria(text)
    if (!items.length) return
    save([...list, ...items.map((x) => ({ text: x, done: false }))])
    setAdd('')
  }
  return (
    <div className="v-crit" data-testid="criteria-editor">
      {list.length === 0 && <div className="v-cnt2" data-testid="criteria-empty">No criteria yet. Add what “done” means below.</div>}
      <ul className="v-steps">
        {list.map((c, i) => (
          <li key={i} className="v-crit-row" data-testid="criterion-row">
            {editing === i ? (
              <CriterionInput text={c.text} onDone={(v) => (v === null ? setEditing(null) : edit(i, v))} />
            ) : (
              <>
                <button
                  type="button"
                  className={'v-st' + (c.done ? ' done' : '')}
                  data-testid="criterion"
                  aria-pressed={c.done}
                  title="Click to tick · double-click to edit"
                  onClick={(e) => {
                    // The circle (and the keyboard) ticks at once; a click on the text waits a moment,
                    // so a double-click edits without ticking.
                    clearTimeout(clickTimer.current)
                    if (e.detail === 0 || (e.target as Element).closest('.v-ck')) return tick(i)
                    if (e.detail > 1) return
                    clickTimer.current = setTimeout(() => tick(i), 250)
                  }}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    clearTimeout(clickTimer.current)
                    setEditing(i)
                  }}
                >
                  <span className="v-ck">{c.done && <IconCheck size={10} strokeWidth={3} />}</span>
                  <span>{c.text}</span>
                </button>
                <span className="v-crit-acts">
                  {i > 0 && (
                    <button type="button" className="v-crit-btn" data-testid="criterion-up" aria-label="Move up" title="Move up" onClick={() => up(i)}>
                      <IconArrowUp size={12} />
                    </button>
                  )}
                  <button type="button" className="v-crit-btn" data-testid="criterion-edit" aria-label="Edit criterion" title="Edit" onClick={() => setEditing(i)}>
                    <IconPencil size={12} />
                  </button>
                  <button type="button" className="v-crit-btn" data-testid="criterion-delete" aria-label="Delete criterion" title="Delete" onClick={() => remove(i)}>
                    <IconClose size={12} />
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      <input
        type="text"
        className="v-crit-add"
        data-testid="criterion-add"
        aria-label="Add a criterion"
        placeholder="+ Add a criterion (↵)"
        value={add}
        maxLength={300}
        onChange={(e) => setAdd(e.target.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text')
          if (text.includes('\n')) {
            e.preventDefault()
            addAll(add + text)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            addAll(add)
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            setAdd('')
            e.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

/** A criterion's text being edited: ↵ or leaving saves (onDone(text)), Esc cancels (onDone(null)). */
function CriterionInput({ text, onDone }: { text: string; onDone: (v: string | null) => void }) {
  const [val, setVal] = useState(text)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      ref={ref}
      type="text"
      className="v-crit-input"
      data-testid="criterion-input"
      aria-label="Criterion"
      value={val}
      maxLength={300}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => finish(val)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault()
          finish(val)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }}
    />
  )
}

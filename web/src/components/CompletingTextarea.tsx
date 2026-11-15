import { useLayoutEffect } from 'react'
import { useMentions } from './Mentions'
import type { fileInputHandlers } from '../lib/uploads'
import { cx } from './ui'

type CompletingProps = {
  sessionId: string | null
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  className?: string
  testid?: string
  /** Open the @ / completions above the field (it sits at the bottom of a column). */
  dropUp?: boolean
  /** Grow with the text, from `min` px up to `max` px (then it scrolls). */
  autoGrow?: { min: number; max: number }
  /** Fill the height of the parent (a flex column) instead of a fixed one. */
  fill?: boolean
}

/** A textarea that completes @files, @agents and /skills of the session's project. */
export const CompletingTextarea = ({ ref, sessionId, value, onChange, onSubmit, placeholder, className, testid = 'compose-body', dropUp, autoGrow, fill, onPaste, onDrop, onDragOver }: CompletingProps & { ref: React.RefObject<HTMLTextAreaElement | null> } & Partial<ReturnType<typeof fileInputHandlers>>) => {
  const mention = useMentions({ sessionId, value, onChange, inputRef: ref, agents: true })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (!autoGrow || fill) {
      el.style.height = ''
      el.style.overflowY = ''
      return
    }
    el.style.height = 'auto'
    const h = Math.min(autoGrow.max, Math.max(autoGrow.min, el.scrollHeight + 2)) // +2: the border
    el.style.height = `${h}px`
    el.style.overflowY = el.scrollHeight + 2 > autoGrow.max ? 'auto' : 'hidden'
  }, [value, autoGrow, fill, ref])
  return (
    <div className={cx('relative', fill && 'min-h-0 flex-1')}>
      <textarea
        ref={ref}
        data-testid={testid}
        aria-label="Body"
        value={value}
        placeholder={placeholder}
        {...mention.handlers}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onKeyDown={(e) => {
          if (mention.onKeyDown(e)) return
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onSubmit()
          }
        }}
        className={cx('w-full resize-none rounded-md border border-linestrong bg-sunken p-2.5 text-[13.5px] outline-none focus:border-accent', fill ? 'h-full' : (className ?? 'h-[120px]'))}
      />
      {mention.popup(dropUp)}
    </div>
  )
}

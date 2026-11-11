import { useEffect, useState } from 'react'
import { Button } from './ui'

export const DRAFT_EXTRA_MAX = 4000

/** Settings › Integrations › Linear › "Auto-fill: extra prompt": the person's own instructions for
 * the helper that pre-fills the Create-issue dialog. Saved with the Save button, not on blur. */
export function LinearExtraPrompt({ value, onSave }: { value: string; onSave: (v: string) => Promise<unknown> | void }) {
  const [text, setText] = useState(value)
  const [busy, setBusy] = useState(false)
  useEffect(() => setText(value), [value])
  const dirty = text !== value
  const over = text.length > DRAFT_EXTRA_MAX
  return (
    <div className="flex flex-col gap-1.5 border-b border-[#1f1f24] py-2 [[data-theme=light]_&]:border-line" data-testid="linear-extra">
      <label htmlFor="linear-extra-text" className="text-[14px]">
        Auto-fill: extra prompt
      </label>
      <span className="text-[12.5px] text-subtle">
        Added to the instructions of the helper that pre-fills the Create Linear issue dialog. It never changes the output format: ids still have to exist in Linear. Examples: “Write titles in
        English. Always add label 'agent'. Use the 'Platform' team unless the thread is about the web UI. Keep descriptions under 15 lines.”
      </span>
      <textarea
        id="linear-extra-text"
        data-testid="linear-extra-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        spellCheck={false}
        className="rounded-lg border border-linestrong bg-sunken px-3 py-2 text-[14px] text-fg outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <span data-testid="linear-extra-count" className={`text-[12px] ${over ? 'text-danger' : 'text-subtle'}`}>
          {text.length} / {DRAFT_EXTRA_MAX}
        </span>
        <span className="flex-1" />
        <Button data-testid="linear-extra-reset" disabled={!dirty || busy} onClick={() => setText(value)}>
          Reset
        </Button>
        <Button
          data-testid="linear-extra-save"
          variant="primary"
          disabled={!dirty || over || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onSave(text)
            } finally {
              setBusy(false)
            }
          }}
        >
          Save
        </Button>
      </div>
    </div>
  )
}

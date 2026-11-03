import { useState } from 'react'
import type { Session } from '../api'
import { useApp } from '../lib/app'
import { Button } from './ui'

const STEPS = [
  { title: 'Have Claude ask you something', prompt: 'Ask me one question in the minbox inbox.' },
  { title: 'Have Claude report when it is done', prompt: 'When you finish, send a short summary to the minbox inbox.' },
]

/** First run: a prompt to copy into the terminal, so Claude writes to the inbox. */
export function NextStep({ session }: { session: Session }) {
  const { toast } = useApp()
  const [step, setStep] = useState(() => Number(localStorage.getItem('minbox:next-step') ?? '0'))
  if (step >= STEPS.length) return null
  const s = STEPS[step]!
  return (
    <div data-testid="next-step" className="mt-3 flex w-full max-w-[360px] flex-col gap-1.5 rounded-[10px] border border-wait/40 bg-wait/6 p-3 text-left">
      <span className="text-[11px] font-bold tracking-[0.06em] text-wait">
        NEXT STEP · {step + 1} of {STEPS.length}
      </span>
      <span className="text-[13.5px] font-semibold">{s.title}</span>
      <span className="mono rounded-[6px] bg-sunken px-2 py-1.5 text-[12px] text-fg2">{s.prompt}</span>
      <div className="flex gap-2">
        <Button
          size="sm"
          className="self-start"
          onClick={() => {
            void navigator.clipboard?.writeText(s.prompt)
            toast(`Copied · paste it into ${session.name}'s terminal`)
          }}
        >
          Copy prompt
        </Button>
        <Button
          size="sm"
          variant="quiet"
          onClick={() => {
            localStorage.setItem('minbox:next-step', String(step + 1))
            setStep(step + 1)
          }}
        >
          {step + 1 < STEPS.length ? 'Next' : 'Done'}
        </Button>
      </div>
    </div>
  )
}

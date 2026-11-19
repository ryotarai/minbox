// The first-run introduction: on a fresh minbox (no project, no agent, the server's `onboarded` setting
// false) a short stepped flow explains a project, an agent and a task while the person makes their first
// project and agent with the real forms; then a hint over the new agent's stream says how to write to it.
// Skip at every step. Finishing or skipping saves `onboarded`, so no browser shows it again; Settings ›
// General › Show the introduction (and Help, and ⌘K) opens it again by hand.
import { useEffect, useRef, useState } from 'react'
import type { Project } from '../api'
import { useApp } from '../lib/app'
import { updateReplyDraft } from '../lib/drafts'
import { NewSessionDialog } from '../components/NewSession'
import { IconAgent, IconClose, IconFiles, IconTasks, IconTerminal } from '../components/icons'
import './onboarding.css'

/** What the first agent is asked, put in its reply box (the person can change it or send it as is). */
export const FIRST_MESSAGE = 'Take a look around this folder and tell me, in a few lines, what it is and how it is organized. Do not change anything yet.'

const STEPS = ['Welcome', 'Project', 'Agent', 'First message'] as const

/** Opens the introduction by hand (Settings, Help, the palette): from any screen, over the main one. */
export function useOpenOnboarding() {
  const { navigate, setOverlay, route } = useApp()
  return () => {
    if (route.view === 'settings' || route.view === 'issues' || route.view === 'slack') navigate({ view: 'main' }, { push: true })
    setOverlay({ kind: 'onboarding' })
  }
}

export function Onboarding() {
  const { settings, saveSettings, projects, sessions, overlay, setOverlay, navigate, route, isPhone } = useApp()
  const open = overlay?.kind === 'onboarding'
  // Step 4: the agent made in step 3, whose stream shows the first-message hint.
  const [coach, setCoach] = useState<string | null>(null)
  const live = sessions?.filter((s) => !s.archived_at) ?? null
  // `onboarded` is true until the server's settings load, so this is a fresh server's answer.
  const fresh = !settings.onboarded && projects !== null && live !== null && projects.length === 0 && live.length === 0
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!fresh || autoOpened.current || overlay || route.view === 'settings' || route.view === 'review') return
    autoOpened.current = true
    setOverlay({ kind: 'onboarding' })
  }, [fresh, overlay, route.view, setOverlay])
  // Projects or agents made some other way (or an older data dir): it is not a first run any more.
  useEffect(() => {
    if (settings.onboarded || open || coach || projects === null || live === null) return
    if (projects.length > 0 || live.length > 0) saveSettings({ onboarded: true })
  }, [settings.onboarded, open, coach, projects, live, saveSettings])
  const done = () => {
    if (!settings.onboarded) saveSettings({ onboarded: true })
  }
  return (
    <>
      {open && (
        <OnboardingDialog
          isPhone={isPhone}
          onSkip={() => {
            done()
            setOverlay(null)
          }}
          onAgent={(id) => {
            done()
            // A first message to start from, unless something is written there already.
            updateReplyDraft('v3:agent:' + id, (d) => (d.words.trim() ? d : { ...d, words: FIRST_MESSAGE }))
            setOverlay(null)
            setCoach(id)
            navigate({ view: 'agent', s: id, k: null, m: null, f: null, tab: 'inbox' }, { push: true })
          }}
        />
      )}
      {coach && route.view === 'agent' && route.s === coach && !open && <FirstMessageHint onClose={() => setCoach(null)} />}
    </>
  )
}

function OnboardingDialog({ isPhone, onSkip, onAgent }: { isPhone: boolean; onSkip: () => void; onAgent: (sessionId: string) => void }) {
  const { projects } = useApp()
  const [step, setStep] = useState(0)
  const [project, setProject] = useState<Project | null>(null)
  // Escape skips (as the Skip button does); the forms' own Escape (a new folder's name) stops first.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onSkip()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onSkip])
  // Back from step 3, or opened again by hand: the projects there are (the one just made too).
  const others = projects ?? []
  return (
    <div className="v-overlay v-onb-ov" data-testid="onboarding">
      <div className="v-onb" role="dialog" aria-modal="true" aria-labelledby="onb-title" data-step={step + 1}>
        <div className="v-onb-top">
          <ol className="v-onb-steps" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'on' : i < step ? 'past' : ''} aria-current={i === step ? 'step' : undefined}>
                <span className="v-onb-n">{i + 1}</span>
                <span className="v-onb-sl">{s}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="v-onb-skip" data-testid="onboarding-skip" onClick={onSkip} title="Skip the introduction (Esc)">
            Skip
            <IconClose size={14} aria-hidden />
          </button>
        </div>
        <div className="v-onb-body">
          {step === 0 && (
            <>
              <h2 id="onb-title">Welcome to minbox</h2>
              <p className="v-onb-lead">minbox runs coding agents in your folders and keeps what they need from you in one place. Three words to know:</p>
              <Diagram />
              <ul className="v-onb-concepts">
                <li data-testid="onboarding-concept-project">
                  <span className="v-onb-ic p">
                    <IconFiles size={16} />
                  </span>
                  <span>
                    <b>Project</b> — a folder or repo you work in. It groups your agents and their tasks.
                  </span>
                </li>
                <li data-testid="onboarding-concept-agent">
                  <span className="v-onb-ic a">
                    <IconAgent size={16} />
                  </span>
                  <span>
                    <b>Agent</b> — a coding agent (Claude Code, Pi or OpenCode) running in that folder. You talk to it through its stream.
                  </span>
                </li>
                <li data-testid="onboarding-concept-task">
                  <span className="v-onb-ic t">
                    <IconTasks size={16} />
                  </span>
                  <span>
                    <b>Task</b> — one piece of work an agent is doing for you, with a checklist and a status. Its messages are grouped in it.
                  </span>
                </li>
              </ul>
              <div className="v-onb-foot">
                <span className="v-sp" />
                <button type="button" className="v-btn pri v-onb-next" data-testid="onboarding-next" autoFocus onClick={() => setStep(1)}>
                  Create your first project
                </button>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <h2 id="onb-title">Create your first project</h2>
              <p className="v-onb-lead">Pick the folder (or repo) you want to work in. Its agents start there; the name is only for you.</p>
              {others.length > 0 && (
                <div className="v-onb-existing" data-testid="onboarding-existing">
                  Or use one you have:
                  {others.slice(0, 6).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="v-btn"
                      data-testid="onboarding-use-project"
                      onClick={() => {
                        setProject(p)
                        setStep(2)
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
              <NewSessionDialog
                key="project"
                mode="project"
                embedded={{ onBack: () => setStep(0) }}
                onClose={() => {}}
                onProjectCreated={(p) => {
                  setProject(p)
                  setStep(2)
                }}
              />
            </>
          )}
          {step === 2 && (
            <>
              <h2 id="onb-title">Start your first agent{project ? ` in ${project.name}` : ''}</h2>
              <p className="v-onb-lead">
                Choose which coding agent to run. It starts right away in the project&apos;s folder.
              </p>
              <p className="v-onb-note" data-testid="onboarding-terminal-note">
                <IconTerminal size={14} aria-hidden /> You talk to the agent in its stream. Its terminal is hidden by default:{' '}
                {isPhone ? 'the terminal button in the agent’s header shows it.' : 'the terminal button in the agent’s header (or T) shows it.'}
              </p>
              <NewSessionDialog key={'agent' + (project?.id ?? '')} mode="session" projectId={project?.id} allAgents embedded={{ onBack: () => setStep(1) }} onClose={() => {}} onCreated={(s) => onAgent(s.id)} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** Project ⟶ Agents ⟶ Tasks, drawn small: one folder, two agents in it, their tasks. */
function Diagram() {
  const task = (x: number, y: number, label: string, done: boolean) => (
    <g>
      <rect x={x} y={y} width={150} height={24} rx={6} className="v-onb-d-task" />
      <rect x={x + 8} y={y + 7} width={10} height={10} rx={2} className={done ? 'v-onb-d-check on' : 'v-onb-d-check'} />
      <text x={x + 26} y={y + 16} className="v-onb-d-t">
        {label}
      </text>
    </g>
  )
  return (
    <svg className="v-onb-diagram" viewBox="0 0 560 150" role="img" aria-label="A project holds agents; each agent works on tasks" data-testid="onboarding-diagram">
      <path d="M150 75 C 185 75, 185 40, 220 40 M150 75 C 185 75, 185 110, 220 110" className="v-onb-d-line" />
      <path d="M355 40 C 375 40, 375 22, 395 22 M355 40 C 375 40, 375 56, 395 56 M355 110 C 375 110, 375 110, 395 110" className="v-onb-d-line" />
      <rect x={10} y={50} width={140} height={50} rx={10} className="v-onb-d-proj" />
      <text x={24} y={71} className="v-onb-d-k">
        PROJECT
      </text>
      <text x={24} y={89} className="v-onb-d-n">
        ~/src/my-app
      </text>
      {(
        [
          [40, 'Claude Code'],
          [110, 'Pi'],
        ] as const
      ).map(([y, kind]) => (
        <g key={kind}>
          <rect x={220} y={y - 22} width={135} height={44} rx={10} className="v-onb-d-agent" />
          <circle cx={236} cy={y - 6} r={4} className="v-onb-d-dot" />
          <text x={246} y={y - 2} className="v-onb-d-k">
            AGENT
          </text>
          <text x={232} y={y + 14} className="v-onb-d-n">
            {kind}
          </text>
        </g>
      ))}
      {task(395, 10, 'Fix the login bug', true)}
      {task(395, 44, 'Add tests', false)}
      {task(395, 98, 'Update the docs', false)}
    </svg>
  )
}

/** Step 4, over the new agent's stream: how to send the first message, where tasks show up. */
function FirstMessageHint({ onClose }: { onClose: () => void }) {
  const { isPhone } = useApp()
  return (
    <aside className="v-onb-hint" data-testid="onboarding-hint" aria-label="Your first message">
      <div className="v-onb-hint-h">
        <span className="v-onb-n">4</span>
        <b>Send your first message</b>
      </div>
      <p>
        Your agent is starting. We put a first message in the box below, asking it to look around: send it as is{isPhone ? '' : ' (⌘↵)'}, or write your own.
      </p>
      <p>
        When the agent takes on work, it files a <b>task</b>: you will see it {isPhone ? 'under Tasks at the top' : 'in the Tasks pane'} and on the Board, with its checklist and status. Questions it asks you show up there too.
      </p>
      <div className="v-onb-foot">
        <span className="v-sp" />
        <button type="button" className="v-btn pri" data-testid="onboarding-done" onClick={onClose}>
          Got it
        </button>
      </div>
    </aside>
  )
}

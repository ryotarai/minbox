// minbox's icons: Lucide (https://lucide.dev), one import per icon so the bundle keeps only those used,
// behind the Icon* names the components use. The size system: 16px in toolbars and buttons (the
// default), 14px in dense rows and chips, 20-22px on phone bars; Lucide's 24-unit grid with its own
// stroke of 2 (about 1.3px at 16px). Colour is currentColor, so text colours, hover, pressed and the
// dark theme apply as they do to text. Kept as drawn here: the agent marks (Claude, OpenCode, Pi) and
// the Linear and Slack marks, which Lucide does not have.
import { useId, type ComponentType, type SVGProps } from 'react'
import type { LucideProps } from 'lucide-react'
import LInbox from 'lucide-react/icons/inbox'
import LSearch from 'lucide-react/icons/search'
import LPlus from 'lucide-react/icons/plus'
import LSparkles from 'lucide-react/icons/sparkles'
import LChevronRight from 'lucide-react/icons/chevron-right'
import LChevronDown from 'lucide-react/icons/chevron-down'
import LChevronUp from 'lucide-react/icons/chevron-up'
import LChevronLeft from 'lucide-react/icons/chevron-left'
import LSettings2 from 'lucide-react/icons/settings-2'
import LCheck from 'lucide-react/icons/check'
import LCopy from 'lucide-react/icons/copy'
import LLayoutGrid from 'lucide-react/icons/layout-grid'
import LChevronsDownUp from 'lucide-react/icons/chevrons-down-up'
import LChevronsUpDown from 'lucide-react/icons/chevrons-up-down'
import LEllipsis from 'lucide-react/icons/ellipsis'
import LEllipsisVertical from 'lucide-react/icons/ellipsis-vertical'
import LGitFork from 'lucide-react/icons/git-fork'
import LArchive from 'lucide-react/icons/archive'
import LArrowUp from 'lucide-react/icons/arrow-up'
import LImage from 'lucide-react/icons/image'
import LSquareTerminal from 'lucide-react/icons/square-terminal'
import LTerminal from 'lucide-react/icons/terminal'
import LBot from 'lucide-react/icons/bot'
import LX from 'lucide-react/icons/x'
import LPaperclip from 'lucide-react/icons/paperclip'
import LShapes from 'lucide-react/icons/shapes'
import LPencil from 'lucide-react/icons/pencil'
import LSquareKanban from 'lucide-react/icons/square-kanban'
import LListChecks from 'lucide-react/icons/list-checks'
import LFolder from 'lucide-react/icons/folder'
import LZap from 'lucide-react/icons/zap'
import LPin from 'lucide-react/icons/pin'
import LMaximize2 from 'lucide-react/icons/maximize-2'
import LMousePointer2 from 'lucide-react/icons/mouse-pointer-2'
import LPen from 'lucide-react/icons/pen'
import LMessageSquare from 'lucide-react/icons/message-square'
import LThumbsUp from 'lucide-react/icons/thumbs-up'
import LRotateCw from 'lucide-react/icons/rotate-cw'
import LRotateCcw from 'lucide-react/icons/rotate-ccw'
import LLink from 'lucide-react/icons/link'
import LMenu from 'lucide-react/icons/menu'
import LTarget from 'lucide-react/icons/target'
import LExternalLink from 'lucide-react/icons/external-link'
import LSquareCheck from 'lucide-react/icons/square-check'
import LSquare from 'lucide-react/icons/square'
import LCircleDot from 'lucide-react/icons/circle-dot'
import LCircle from 'lucide-react/icons/circle'
import LArrowDown from 'lucide-react/icons/arrow-down'
import LArrowLeft from 'lucide-react/icons/arrow-left'
import LArrowRight from 'lucide-react/icons/arrow-right'
import LEraser from 'lucide-react/icons/eraser'
import LMoveUpRight from 'lucide-react/icons/move-up-right'
import LRedo2 from 'lucide-react/icons/redo-2'
import LUndo2 from 'lucide-react/icons/undo-2'
import LChevronsLeft from 'lucide-react/icons/chevrons-left'
import LAtSign from 'lucide-react/icons/at-sign'
import LHash from 'lucide-react/icons/hash'
import LCommand from 'lucide-react/icons/command'
import LFileCode from 'lucide-react/icons/file-code'
import LFile from 'lucide-react/icons/file'
import LFileText from 'lucide-react/icons/file-text'
import LPlay from 'lucide-react/icons/play'
import LWorkflow from 'lucide-react/icons/workflow'
import LInfo from 'lucide-react/icons/info'
import LTriangleAlert from 'lucide-react/icons/triangle-alert'
import LKey from 'lucide-react/icons/key'
import LPackage from 'lucide-react/icons/package'
import LClock from 'lucide-react/icons/clock'
import LCornerUpLeft from 'lucide-react/icons/corner-up-left'
import LSlash from 'lucide-react/icons/slash'
import LRectangleHorizontal from 'lucide-react/icons/rectangle-horizontal'
import LType from 'lucide-react/icons/type'
import LCheckCheck from 'lucide-react/icons/check-check'
import LBookOpen from 'lucide-react/icons/book-open'

type P = SVGProps<SVGSVGElement> & { size?: number }

/** One Lucide icon as an Icon*: 16px, decorative (aria-hidden) unless given a label. */
function lucide(I: ComponentType<LucideProps>) {
  const C = ({ size = 16, ...p }: P) => <I aria-hidden="true" size={size} {...(p as LucideProps)} />
  C.displayName = 'Icon(' + (I.displayName ?? '') + ')'
  return C
}

export const IconInbox = /*#__PURE__*/ lucide(LInbox)
export const IconSearch = /*#__PURE__*/ lucide(LSearch)
export const IconPlus = /*#__PURE__*/ lucide(LPlus)
export const IconSparkle = /*#__PURE__*/ lucide(LSparkles)
export const IconChevronRight = /*#__PURE__*/ lucide(LChevronRight)
export const IconChevronDown = /*#__PURE__*/ lucide(LChevronDown)
export const IconChevronUp = /*#__PURE__*/ lucide(LChevronUp)
export const IconBack = /*#__PURE__*/ lucide(LChevronLeft)
export const IconSettings = /*#__PURE__*/ lucide(LSettings2)
export const IconCheck = /*#__PURE__*/ lucide(LCheck)
export const IconCopy = /*#__PURE__*/ lucide(LCopy)
export const IconGrid = /*#__PURE__*/ lucide(LLayoutGrid)
export const IconFold = /*#__PURE__*/ lucide(LChevronsDownUp)
export const IconUnfold = /*#__PURE__*/ lucide(LChevronsUpDown)
export const IconMore = /*#__PURE__*/ lucide(LEllipsis)
export const IconMoreV = /*#__PURE__*/ lucide(LEllipsisVertical)
export const IconFork = /*#__PURE__*/ lucide(LGitFork)
export const IconArchive = /*#__PURE__*/ lucide(LArchive)
export const IconSend = /*#__PURE__*/ lucide(LArrowUp)
export const IconArrowUp = /*#__PURE__*/ lucide(LArrowUp)
export const IconImage = /*#__PURE__*/ lucide(LImage)
export const IconTerminal = /*#__PURE__*/ lucide(LSquareTerminal)
export const IconShell = /*#__PURE__*/ lucide(LTerminal)
export const IconAgent = /*#__PURE__*/ lucide(LBot)
export const IconClose = /*#__PURE__*/ lucide(LX)
export const IconPaperclip = /*#__PURE__*/ lucide(LPaperclip)
export const IconSketch = /*#__PURE__*/ lucide(LShapes)
export const IconPencil = /*#__PURE__*/ lucide(LPencil)
export const IconBoard = /*#__PURE__*/ lucide(LSquareKanban)
export const IconTasks = /*#__PURE__*/ lucide(LListChecks)
export const IconFiles = /*#__PURE__*/ lucide(LFolder)
export const IconBolt = /*#__PURE__*/ lucide(LZap)
export const IconPin = /*#__PURE__*/ lucide(LPin)
export const IconExpand = /*#__PURE__*/ lucide(LMaximize2)
export const IconSelect = /*#__PURE__*/ lucide(LMousePointer2)
export const IconPen = /*#__PURE__*/ lucide(LPen)
export const IconComment = /*#__PURE__*/ lucide(LMessageSquare)
export const IconThumb = /*#__PURE__*/ lucide(LThumbsUp)
export const IconRefresh = /*#__PURE__*/ lucide(LRotateCw)
export const IconUndo = /*#__PURE__*/ lucide(LRotateCcw)
export const IconLink = /*#__PURE__*/ lucide(LLink)
export const IconMenu = /*#__PURE__*/ lucide(LMenu)
export const IconGoal = /*#__PURE__*/ lucide(LTarget)
export const IconExternal = /*#__PURE__*/ lucide(LExternalLink)
export const IconCheckSquare = /*#__PURE__*/ lucide(LSquareCheck)
export const IconSquare = /*#__PURE__*/ lucide(LSquare)
export const IconRadioOn = /*#__PURE__*/ lucide(LCircleDot)
export const IconRadioOff = /*#__PURE__*/ lucide(LCircle)
export const IconArrowDown = /*#__PURE__*/ lucide(LArrowDown)
export const IconArrowLeft = /*#__PURE__*/ lucide(LArrowLeft)
export const IconArrowRight = /*#__PURE__*/ lucide(LArrowRight)
export const IconEraser = /*#__PURE__*/ lucide(LEraser)
export const IconArrow = /*#__PURE__*/ lucide(LMoveUpRight)
export const IconRedo = /*#__PURE__*/ lucide(LRedo2)
export const IconUndoStep = /*#__PURE__*/ lucide(LUndo2)
export const IconFoldLeft = /*#__PURE__*/ lucide(LChevronsLeft)
export const IconAt = /*#__PURE__*/ lucide(LAtSign)
export const IconHash = /*#__PURE__*/ lucide(LHash)
export const IconCommand = /*#__PURE__*/ lucide(LCommand)
export const IconFileCode = /*#__PURE__*/ lucide(LFileCode)
export const IconFile = /*#__PURE__*/ lucide(LFile)
export const IconFileText = /*#__PURE__*/ lucide(LFileText)
export const IconPlay = /*#__PURE__*/ lucide(LPlay)
export const IconDiagram = /*#__PURE__*/ lucide(LWorkflow)
export const IconInfo = /*#__PURE__*/ lucide(LInfo)
export const IconWarning = /*#__PURE__*/ lucide(LTriangleAlert)
export const IconKey = /*#__PURE__*/ lucide(LKey)
export const IconPackage = /*#__PURE__*/ lucide(LPackage)
export const IconClock = /*#__PURE__*/ lucide(LClock)
export const IconReply = /*#__PURE__*/ lucide(LCornerUpLeft)
export const IconLine = /*#__PURE__*/ lucide(LSlash)
export const IconRect = /*#__PURE__*/ lucide(LRectangleHorizontal)
export const IconEllipse = /*#__PURE__*/ lucide(LCircle)
export const IconText = /*#__PURE__*/ lucide(LType)
export const IconCheckCheck = /*#__PURE__*/ lucide(LCheckCheck)
export const IconReview = /*#__PURE__*/ lucide(LBookOpen)

/** The minbox brand marks, kept custom: drawn on a 16×16 grid, stroked with currentColor. */
function Svg({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  )
}

export const IconClaude = ({ size = 13, ...p }: P) => (
  <Svg strokeWidth={2} size={size} {...p}>
    <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
  </Svg>
)
/** OpenCode's mark: a tall block with a smaller one sunk into its lower half. */
export const IconOpenCode = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <rect x="3" y="1.75" width="10" height="12.5" rx="1" />
    <rect x="5.75" y="7" width="4.5" height="4.5" fill="currentColor" stroke="none" opacity={0.55} />
  </Svg>
)
/** Pi's mark: the letter π. */
export const IconPi = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <path d="M2.5 5.5c.8-1 1.7-1.25 3-1.25h8" />
    <path d="M6.25 4.5c0 3.5-.6 6-1.75 8" />
    <path d="M10.5 4.5v6.25c0 1.1.5 1.75 1.5 1.75.6 0 1-.25 1.4-.7" />
  </Svg>
)
/** The icon of a session's coding agent (sessions.agent; missing means Claude Code). */
export function IconAgentKind({ kind, ...p }: P & { kind?: string }) {
  if (!kind || kind === 'claude') return <IconClaude {...p} />
  if (kind === 'opencode') return <IconOpenCode {...p} />
  if (kind === 'pi') return <IconPi {...p} />
  return <IconAgent {...p} />
}
/** A simple geometric take on Linear's mark: a solid disc cut by diagonal stripes (not the official artwork). */
export function IconLinear(p: P) {
  const mid = 'linear-mask-' + useId().replace(/:/g, '')
  return (
    <Svg fill="currentColor" stroke="none" {...p}>
      <mask id={mid} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
        <rect width="16" height="16" fill="white" />
        <g stroke="black" strokeWidth="1.1" strokeLinecap="butt">
          <path d="M-1 6 10 17" />
          <path d="M-1 2.5 13.5 17" />
          <path d="M2.5 -1 17 13.5" />
          <path d="M6 -1 17 10" />
        </g>
      </mask>
      <circle cx="8" cy="8" r="7.2" mask={`url(#${mid})`} />
    </Svg>
  )
}

/** A simple geometric take on Slack's mark: four rounded bars, each with a dot, as a pinwheel (not the official artwork). */
export function IconSlack(p: P) {
  return (
    <Svg fill="currentColor" stroke="none" {...p}>
      <rect x="1.4" y="6.6" width="5.6" height="2" rx="1" />
      <circle cx="3.2" cy="4.6" r="1.05" />
      <rect x="7.4" y="1.4" width="2" height="5.6" rx="1" />
      <circle cx="11.4" cy="3.2" r="1.05" />
      <rect x="9" y="7.4" width="5.6" height="2" rx="1" />
      <circle cx="12.8" cy="11.4" r="1.05" />
      <rect x="6.6" y="9" width="2" height="5.6" rx="1" />
      <circle cx="4.6" cy="12.8" r="1.05" />
    </Svg>
  )
}

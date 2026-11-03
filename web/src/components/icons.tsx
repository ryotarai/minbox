// Line icons on a 16×16 grid, stroked with currentColor.
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {children}
    </svg>
  )
}

export const IconInbox = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M2.5 9.5h3l1 2h3l1-2h3" />
    <path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11z" />
  </Svg>
)
export const IconSearch = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </Svg>
)
export const IconPlus = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
)
export const IconChevronRight = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <path d="M6 3l5 5-5 5" />
  </Svg>
)
export const IconChevronDown = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <path d="M3 6l5 5 5-5" />
  </Svg>
)
export const IconBack = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <path d="M10 3 5 8l5 5" />
  </Svg>
)
export const IconSettings = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
    <circle cx="10" cy="4.5" r="1.5" />
    <circle cx="6" cy="11.5" r="1.5" />
  </Svg>
)
export const IconPanelRight = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M10 2.5v11" />
  </Svg>
)
export const IconPanelLeft = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <rect x="2" y="2.5" width="12" height="11" rx="2" />
    <path d="M6 2.5v11" />
  </Svg>
)
export const IconCheck = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <path d="M3 8.5 6.5 12 13 4.5" />
  </Svg>
)
export const IconGrid = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </Svg>
)
export const IconFold = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <path d="M4.5 2.5 8 6l3.5-3.5M4.5 13.5 8 10l3.5 3.5" />
  </Svg>
)
export const IconUnfold = (p: P) => (
  <Svg strokeWidth={1.6} {...p}>
    <path d="M4.5 6 8 2.5 11.5 6M4.5 10 8 13.5l3.5-3.5" />
  </Svg>
)
export const IconMore = ({ size = 16, ...p }: P) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
)
export const IconMoreV = ({ size = 16, ...p }: P) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="currentColor" {...p}>
    <circle cx="8" cy="3.5" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="8" cy="12.5" r="1.2" />
  </svg>
)
export const IconArchive = (p: P) => (
  <Svg strokeWidth={1.4} {...p}>
    <rect x="2" y="3" width="12" height="3.5" rx="1" />
    <path d="M3 6.5V13h10V6.5M6.5 9h3" />
  </Svg>
)
export const IconMail = (p: P) => (
  <Svg strokeWidth={1.4} {...p}>
    <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
    <path d="M2.5 4.5 8 9l5.5-4.5" />
  </Svg>
)
export const IconSend = (p: P) => (
  <Svg strokeWidth={2} {...p}>
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </Svg>
)
export const IconImage = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <rect x="1.5" y="3" width="13" height="10" rx="2" />
    <circle cx="5.5" cy="7" r="1.3" />
    <path d="m14.5 11-3.5-3.5L4 13" />
  </Svg>
)
export const IconTerminal = (p: P) => (
  <Svg strokeWidth={1.3} {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" />
    <path d="m4.5 6.5 2 1.5-2 1.5M8.5 10h3" />
  </Svg>
)
export const IconClaude = ({ size = 13, ...p }: P) => (
  <Svg strokeWidth={2} size={size} {...p}>
    <path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" />
  </Svg>
)
export const IconClose = (p: P) => (
  <Svg strokeWidth={1.75} {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
)
export const IconPaperclip = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M13 7.5 8 12.5a3 3 0 0 1-4.2-4.2l5.5-5.5a2 2 0 0 1 2.8 2.8L6.6 11.1a1 1 0 0 1-1.4-1.4L10 4.9" />
  </Svg>
)
export const IconBoard = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <rect x="1.5" y="2.5" width="3.5" height="11" rx="1" />
    <rect x="6.25" y="2.5" width="3.5" height="7" rx="1" />
    <rect x="11" y="2.5" width="3.5" height="9" rx="1" />
  </Svg>
)
export const IconBolt = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />
  </Svg>
)
export const IconPin = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M6 2.5h4l-.5 4 2.5 2.5H4L6.5 6.5zM8 9v4.5" />
  </Svg>
)
export const IconExpand = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </Svg>
)
export const IconSelect = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M3 2.5 12.5 7 8 8.5 6.5 13z" />
  </Svg>
)
export const IconRegion = (p: P) => (
  <Svg strokeWidth={1.5} strokeDasharray="2 1.6" {...p}>
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
  </Svg>
)
export const IconPen = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" />
  </Svg>
)
export const IconComment = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />
  </Svg>
)
export const IconThumb = (p: P) => (
  <Svg strokeWidth={1.4} {...p}>
    <path d="M5 7v6.5H2.5V7zM5 7l2.5-4.5c1 0 1.7.8 1.5 1.8L8.6 6.5h4a1.3 1.3 0 0 1 1.3 1.6l-1 4.2a1.6 1.6 0 0 1-1.5 1.2H5" />
  </Svg>
)
export const IconRefresh = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M13 4.5V2M13 4.5h-2.5M12.6 4.4A5.5 5.5 0 1 0 13.5 8" />
  </Svg>
)
export const IconLink = (p: P) => (
  <Svg strokeWidth={1.5} {...p}>
    <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" />
  </Svg>
)

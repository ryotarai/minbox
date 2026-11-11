import type { CSSProperties } from 'react'

/** A stable hue (0-359) from a project id. The one source of a project's identity colour: the thread-list badge and the project rail both use it. */
export function projectHue(id: string): number {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

/** Inline style that sets `--h`; the colours themselves live in .proj-badge / .proj-tint (index.css). */
export function projectHueStyle(id: string): CSSProperties {
  return { '--h': projectHue(id) } as CSSProperties
}

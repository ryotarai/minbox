/** "10:52", "Yesterday", "Mon", "Oct 3": short, like a mail list. */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return hm(d)
  const yesterday = new Date(now.getTime() - 86_400_000)
  if (yesterday.toDateString() === d.toDateString()) return 'Yesterday'
  const days = (now.getTime() - d.getTime()) / 86_400_000
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function hm(d: Date | string): string {
  const v = typeof d === 'string' ? new Date(d) : d
  return v.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

/** "1 h", "12 min", "3 d": how long a thread has been going. */
export function span(fromIso: string, toIso?: string): string {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

export function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
}

export function oneLine(s: string, max = 120): string {
  const t = s
    .replace(/:::[a-z-]*/g, '')
    .replace(/[#>*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

export function homeRelative(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

export function plural(n: number, word: string, many?: string): string {
  return `${n} ${n === 1 ? word : (many ?? word + 's')}`
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Two-letter initials of a session name: "minbox-ui" → "MU". */
export function initials(name: string): string {
  const parts = name.split(/[-_\s./]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

export function fileExt(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1]!.toUpperCase().slice(0, 4) : 'FILE'
}

export function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

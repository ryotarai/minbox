// Attachment wording and grouping, after Plannotator Inbox
// (ported from Plannotator; see THIRD_PARTY_NOTICES.md).
import type { Attachment, AttachmentDetail, AttachmentType, Message } from '../api'
import { hm } from './format'

export function typeOf(a: Attachment): AttachmentType {
  if (a.type) return a.type
  // Older attachments: guess from the mime type.
  if (a.mime.startsWith('image/')) return 'image'
  if (a.mime.startsWith('video/')) return 'video'
  if (a.mime === 'application/pdf') return 'pdf'
  if (/\.mdx?$/i.test(a.name)) return 'markdown'
  if (a.mime.startsWith('text/')) return 'code'
  return 'file'
}

/** 1024-based, like Plannotator's formatBytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

function ext(name: string): string {
  const m = /\.([^.]+)$/.exec(name)
  return m ? m[1]!.toLowerCase() : ''
}

const IMAGE_LABEL: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
  'image/bmp': 'BMP',
  'image/x-icon': 'ICO',
  'image/vnd.microsoft.icon': 'ICO',
  'image/svg+xml': 'SVG',
}

/** "Markdown", "JSON", "Code (.go)", "PNG image", "MP4 video", "PDF", "ZIP file". */
export function kindLabel(a: Attachment): string {
  const t = typeOf(a)
  const e = ext(a.name)
  switch (t) {
    case 'markdown':
      return 'Markdown'
    case 'html':
      return 'HTML'
    case 'mermaid':
      return 'Mermaid'
    case 'graphviz':
      return 'Graphviz'
    case 'text':
      return e === 'txt' || !e ? 'Text' : e.toUpperCase()
    case 'code':
      return e ? `Code (.${e})` : `Code (${a.name})`
    case 'image':
      return IMAGE_LABEL[a.mime] ? `${IMAGE_LABEL[a.mime]} image` : 'Image'
    case 'video':
      return a.mime === 'video/quicktime' ? 'MOV video' : a.mime === 'video/webm' ? 'WebM video' : 'MP4 video'
    case 'pdf':
      return 'PDF'
    default:
      return e ? `${e.toUpperCase()} file` : 'File'
  }
}

/** m:ss, h:mm:ss from an hour; floored. */
export function videoTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "1280 × 800, 79 KB", "MP4 video · 7:41 · 1920 × 1080 · 461 MB", "Markdown, 4.2 KB". */
export function sizeLine(a: Attachment): string {
  const t = typeOf(a)
  const dims = a.width && a.height ? `${a.width} × ${a.height}` : ''
  if (t === 'image') return dims ? `${dims}, ${formatBytes(a.size)}` : `${kindLabel(a)}, ${formatBytes(a.size)}`
  if (t === 'video') return [kindLabel(a), a.duration_ms ? videoTime(a.duration_ms / 1000) : '', dims, formatBytes(a.size)].filter(Boolean).join(' · ')
  return `${kindLabel(a)}, ${formatBytes(a.size)}`
}

/** Types the viewer opens beside the thread (pdf and file download). */
export function opensBeside(a: Attachment): boolean {
  const t = typeOf(a)
  return t !== 'pdf' && t !== 'file'
}

/** Text that reads as code in the viewer (config and data files). */
export function viewsAsCode(a: Attachment): boolean {
  const t = typeOf(a)
  if (t === 'code') return true
  if (t !== 'text') return false
  return /\.(log|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|xml)$/i.test(a.name) || /\.env\.example$/i.test(a.name)
}

export type ChangeState = { short: string; long: string } | null

export function changeState(d: AttachmentDetail | undefined): ChangeState {
  if (!d) return null
  if (d.unavailable?.code === 'attachment_missing') return { short: 'No longer on disk', long: 'No longer on disk; the sent version opens' }
  if (d.unavailable?.code === 'attachment_changed_type') return { short: 'Changed type', long: 'Changed type; the sent version opens' }
  if (d.changed) return { short: `Changed ${d.modified_at ? hm(d.modified_at) : ''}`.trim(), long: `Changed since it was sent${d.modified_at ? `, edited ${hm(d.modified_at)}` : ''}` }
  return null
}

/** Every artifact of a thread, in thread order: per message its inline images, then its files. */
export function threadArtifacts(messages: Message[]): Attachment[] {
  const out: Attachment[] = []
  for (const m of messages) {
    const files = m.attachments ?? []
    const seen = new Set(files.map((a) => a.path))
    for (const img of m.inline_images ?? []) if (!seen.has(img.path)) out.push(img)
    out.push(...files)
  }
  return out
}

/** Files the viewer steps through with ] and [ (no guided reviews). */
export function steppable(messages: Message[]): Attachment[] {
  return threadArtifacts(messages).filter((a) => a.kind !== 'review' && opensBeside(a))
}

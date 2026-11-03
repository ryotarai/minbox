import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, uploadToInbox, type AttachmentType, type Upload } from '../api'
import { formatBytes } from './attachments'
import { cx } from '../components/ui'

// Files the person attaches to a reply or a new message: the paperclip, a
// paste, or a drop (Plannotator spec §6). Uploaded at once, kept in the draft.

export const PASTE_TO_FILE_BYTES = 32 * 1024
const PASTED_UNDO_MS = 10_000
const GENERIC_NAME = /^(?:image|blob|pasted graphic(?: \d+)?|clipboard(?:[ -]?image)?|untitled)(?:\.[a-z0-9]+)?$/i
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
}

export type ComposeFile = {
  key: string
  name: string
  size: number
  type?: AttachmentType
  state: 'uploading' | 'done' | 'error'
  progress: number
  error?: string
  upload_id?: string
  /** A local preview of an image. */
  preview?: string
  /** A long paste turned into a file: where it was and how it began. */
  pasted?: { at: number; lead: string; preview: string; text: string; time: number }
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name
  const m = /^(.*?)(\.[^.]*)?$/.exec(name)!
  for (let i = 2; ; i++) {
    const n = `${m[1]}-${i}${m[2] ?? ''}`
    if (!taken.has(n)) return n
  }
}

/** Names a pasted file; generic clipboard names get pasted-image/pasted-file-<time>. */
export function pastedName(file: File, taken: Set<string>): string {
  if (file.name && !GENERIC_NAME.test(file.name)) return unique(file.name, taken)
  const isImage = file.type.startsWith('image/')
  const ext = MIME_EXT[file.type] ?? (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? (isImage ? 'png' : 'bin'))
  return unique(`${isImage ? 'pasted-image' : 'pasted-file'}-${stamp()}.${ext}`, taken)
}

export function isLongPaste(text: string): boolean {
  if (text.length >= PASTE_TO_FILE_BYTES) return true
  if (text.length * 3 < PASTE_TO_FILE_BYTES) return false
  return new TextEncoder().encode(text).length >= PASTE_TO_FILE_BYTES
}

// Per thread (or compose draft) file lists, shared across components.
const stores = new Map<string, ComposeFile[]>()
const listeners = new Set<() => void>()
const KEY = 'minbox:files:'
function load(id: string): ComposeFile[] {
  if (!stores.has(id)) {
    try {
      stores.set(id, (JSON.parse(localStorage.getItem(KEY + id) ?? '[]') as ComposeFile[]).filter((f) => f.state === 'done'))
    } catch {
      stores.set(id, [])
    }
  }
  return stores.get(id)!
}
function save(id: string, files: ComposeFile[]) {
  stores.set(id, files)
  const keep = files.filter((f) => f.state === 'done').map(({ preview: _p, ...f }) => f)
  if (keep.length) localStorage.setItem(KEY + id, JSON.stringify(keep))
  else localStorage.removeItem(KEY + id)
  for (const l of listeners) l()
}

export function clearFiles(id: string) {
  save(id, [])
}

export function uploadIds(id: string): string[] {
  return load(id)
    .filter((f) => f.state === 'done' && f.upload_id)
    .map((f) => f.upload_id!)
}

export function useComposeFiles(id: string) {
  const files = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => load(id),
  )
  const aborts = useRef(new Map<string, () => void>())
  const patch = useCallback((key: string, p: Partial<ComposeFile>) => save(id, load(id).map((f) => (f.key === key ? { ...f, ...p } : f))), [id])

  const add = useCallback(
    (file: Blob, name: string, extra: Partial<ComposeFile> = {}) => {
      const key = `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined
      save(id, [...load(id), { key, name, size: file.size, state: 'uploading', progress: 0, preview, ...extra }])
      const up = uploadToInbox(file, name, (sent, total) => patch(key, { progress: total ? sent / total : 0 }))
      aborts.current.set(key, up.abort)
      up.promise
        .then((u: Upload) => patch(key, { state: 'done', progress: 1, upload_id: u.upload_id, type: u.type, size: u.size, name: u.name }))
        .catch((e: Error) => {
          if (e.message === 'aborted') save(id, load(id).filter((f) => f.key !== key))
          else patch(key, { state: 'error', error: e.message })
        })
        .finally(() => aborts.current.delete(key))
      return key
    },
    [id, patch],
  )

  const addFiles = useCallback(
    (list: File[], fromPaste = false) => {
      const taken = new Set(load(id).map((f) => f.name))
      for (const f of list) {
        const name = fromPaste ? pastedName(f, taken) : unique(f.name || 'file', taken)
        taken.add(name)
        add(f, name)
      }
    },
    [id, add],
  )

  const addPastedText = useCallback(
    (text: string, at: number) => {
      const taken = new Set(load(id).map((f) => f.name))
      const name = unique(`pasted-text-${stamp()}.txt`, taken)
      const first = (text.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
      add(new Blob([text], { type: 'text/plain' }), name, { pasted: { at, lead: '', preview: first || 'Pasted text', text, time: Date.now() } })
    },
    [id, add],
  )

  const remove = useCallback(
    (key: string) => {
      const f = load(id).find((x) => x.key === key)
      aborts.current.get(key)?.()
      if (f?.upload_id) api.deleteUpload(f.upload_id).catch(() => {})
      save(id, load(id).filter((x) => x.key !== key))
    },
    [id],
  )

  return { files, addFiles, addPastedText, remove }
}

/** The file tiles under a reply box or a new message. */
export function ComposeFileTiles({ files, onRemove, onPutBack }: { files: ComposeFile[]; onRemove: (key: string) => void; onPutBack: (f: ComposeFile) => void }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!files.some((f) => f.pasted && Date.now() - f.pasted.time < PASTED_UNDO_MS)) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [files])
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="compose-files" aria-live="polite">
      {files.map((f) => {
        const fresh = f.pasted && Date.now() - f.pasted.time < PASTED_UNDO_MS
        return (
          <div
            key={f.key}
            data-testid="compose-file"
            data-state={f.state}
            className={cx('group relative flex max-w-[260px] items-center gap-2 rounded-lg border bg-raised py-1.5 pl-1.5 pr-7', f.state === 'error' ? 'border-danger/60' : 'border-line2')}
          >
            {f.preview ? (
              <img alt="" src={f.preview} className="h-8 w-8 shrink-0 rounded object-cover" />
            ) : (
              <span aria-hidden="true" className="mono flex h-8 w-8 shrink-0 items-center justify-center rounded bg-chip text-[10px] text-muted">
                {f.pasted ? 'TXT' : (/\.([^.]+)$/.exec(f.name)?.[1] ?? '').toUpperCase().slice(0, 4) || 'FILE'}
              </span>
            )}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px] font-semibold">{f.pasted ? f.pasted.preview : f.name}</span>
              {f.state === 'uploading' ? (
                <span className="text-[11px] text-subtle">
                  Uploading… {Math.round(f.progress * 100)}% of {formatBytes(f.size)}
                  <span className="mt-0.5 block h-[3px] w-full rounded bg-line2">
                    <span className="block h-[3px] rounded bg-accent" style={{ width: `${Math.round(f.progress * 100)}%` }} />
                  </span>
                </span>
              ) : f.state === 'error' ? (
                <span role="alert" className="truncate text-[11px] text-danger">
                  {f.error}
                </span>
              ) : f.pasted ? (
                <span className="text-[11px] text-subtle">
                  Pasted text ·{' '}
                  <button type="button" onClick={() => onPutBack(f)} className="border-0 bg-transparent p-0 text-wait underline" data-testid="put-back">
                    {fresh ? 'Undo' : 'Put back in box'}
                  </button>
                </span>
              ) : (
                <span className="text-[11px] text-subtle">{formatBytes(f.size)}</span>
              )}
            </span>
            <button
              type="button"
              aria-label={f.state === 'uploading' ? `Stop uploading ${f.name}` : `Remove ${f.name}`}
              onClick={() => onRemove(f.key)}
              className="absolute right-1 top-1 border-0 bg-transparent px-1 text-subtle hover:text-fg"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** Paste and drop handling for a text box that takes files. */
export function fileInputHandlers(
  addFiles: (f: File[], fromPaste?: boolean) => void,
  addPastedText: (t: string, at: number) => void,
) {
  return {
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.files)
      const text = e.clipboardData.getData('text/plain')
      if (files.length > 0) {
        // Text with files (a spreadsheet cell copy): only files with a real name.
        const named = text ? files.filter((f) => f.name && !GENERIC_NAME.test(f.name)) : files
        if (named.length > 0) addFiles(named, true)
        if (!text) e.preventDefault()
        return
      }
      if (text && isLongPaste(text)) {
        e.preventDefault()
        addPastedText(text, e.currentTarget.selectionStart ?? 0)
      }
    },
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files)
      if (files.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      addFiles(files)
    },
  }
}

import type { Terminal as GhosttyTerminal } from 'ghostty-web'

type Cell = { codepoint: number; width: number; grapheme_len: number }
type Pos = { col: number; absoluteRow: number }
type Wasm = {
  getScrollbackLength(): number
  getScrollbackLine(row: number): Cell[] | null
  getScrollbackGraphemeString(row: number, col: number): string
  getLine(row: number): Cell[] | null
  getGraphemeString(row: number, col: number): string
  isRowWrapped(row: number): boolean
}

/**
 * Copy keeps a long line whole. ghostty-web's own getSelection ends every row of the selection
 * with a newline, so a line the terminal soft-wrapped (one logical line drawn over several rows)
 * was copied with a line break at each wrap point. Its selection text (mouse-up copy, double-click
 * copy, the context menu's copy, term.getSelection()) is built here instead: a row the next one
 * continues is joined to it, untrimmed, with no newline; other rows end as before, with their
 * trailing blanks trimmed.
 *
 * Whether a row continues the one above is known for the rows on screen (ghostty's isRowWrapped).
 * The scrollback lines ghostty-web exposes carry no such flag: there a row filled to its last
 * column is read as wrapping into the next, as a soft wrap leaves it.
 */
export function joinWrappedRowsOnCopy(term: GhosttyTerminal) {
  const t = term as unknown as {
    wasmTerm?: Wasm
    selectionManager?: { selectionStart: Pos | null; selectionEnd: Pos | null; getSelection(): string }
  }
  const sm = t.selectionManager
  if (!sm) return
  sm.getSelection = () => {
    const w = t.wasmTerm
    if (!w || !sm.selectionStart || !sm.selectionEnd) return ''
    return selectionText(w, sm.selectionStart, sm.selectionEnd)
  }
}

function selectionText(w: Wasm, a: Pos, b: Pos): string {
  if (a.absoluteRow > b.absoluteRow || (a.absoluteRow === b.absoluteRow && a.col > b.col)) [a, b] = [b, a]
  const sb = w.getScrollbackLength()
  const line = (row: number) => (row < sb ? w.getScrollbackLine(row) : w.getLine(row - sb))
  const grapheme = (row: number, col: number) =>
    row < sb ? w.getScrollbackGraphemeString(row, col) : w.getGraphemeString(row - sb, col)
  // Does `row` carry on the logical line of the row above it?
  const continues = (row: number, above: Cell[] | null) => {
    if (row >= sb) return w.isRowWrapped(row - sb)
    const last = above?.[above.length - 1]
    return !!last && last.codepoint !== 0
  }

  let out = ''
  let cells = line(a.absoluteRow)
  for (let row = a.absoluteRow; row <= b.absoluteRow; row++) {
    const next = row < b.absoluteRow ? line(row + 1) : null
    const joined = row < b.absoluteRow && continues(row + 1, cells)
    if (cells) {
      const from = row === a.absoluteRow ? a.col : 0
      const to = row === b.absoluteRow ? Math.min(b.col, cells.length - 1) : cells.length - 1
      let text = ''
      // Trailing blanks are trimmed; on a joined row only the cells nothing was written to (a
      // space typed before the wrap point is part of the line).
      let kept = 0
      for (let col = from; col <= to; col++) {
        const c = cells[col]!
        if (c.codepoint === 0) {
          if (c.width === 0) continue // the second half of a wide character
          text += ' ' // a cell nothing was written to
          continue
        }
        const ch = c.grapheme_len > 0 ? grapheme(row, col) : String.fromCodePoint(c.codepoint)
        text += ch
        if (joined || ch.trim()) kept = text.length
      }
      out += text.slice(0, kept)
    }
    if (row < b.absoluteRow && !joined) out += '\n'
    cells = next
  }
  return out
}

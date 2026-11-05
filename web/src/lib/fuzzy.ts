// Fuzzy matching for the quick-open palette: the query's letters must appear in the text in
// order (a subsequence), and the best alignment wins. A match scores higher when it starts the
// text or a word, runs consecutively, skips few letters, and sits in a short text.

export type Match = { score: number; idx: number[] }

const NEG = -1e9
const GAP = 1
const CONSECUTIVE = 8
const MAX_LEN = 240

function isSep(c: string): boolean {
  return !/[\p{L}\p{N}]/u.test(c)
}

/** Bonus for matching at position j: the text's start, a word start, a camelCase hump. */
function bonus(t: string, j: number): number {
  if (j === 0) return 8
  const p = t[j - 1]!
  if (isSep(p)) return 6
  if (p !== p.toUpperCase() && t[j] !== t[j]!.toLowerCase()) return 5
  return 0
}

/** Matches a single word (no spaces) against `text`; null when it is not a subsequence. */
export function fuzzyMatch(query: string, text: string): Match | null {
  const t = text.slice(0, MAX_LEN)
  const q = query.toLowerCase()
  const tl = t.toLowerCase()
  const m = q.length
  const n = t.length
  if (m === 0) return { score: 0, idx: [] }
  if (m > n) return null
  // Quick reject: is it a subsequence at all?
  let qi = 0
  for (let k = 0; k < n && qi < m; k++) if (tl[k] === q[qi]) qi++
  if (qi < m) return null
  const dp = new Float64Array(m * n).fill(NEG)
  const from = new Int32Array(m * n).fill(-1)
  for (let j = 0; j < n; j++) {
    if (tl[j] === q[0]) dp[j] = 1 + bonus(t, j) - Math.min(j, 12) * 0.3
  }
  for (let i = 1; i < m; i++) {
    let best = NEG
    let bestK = -1
    for (let j = 1; j < n; j++) {
      const k = j - 2
      if (k >= 0) {
        const v = dp[(i - 1) * n + k]!
        if (v > NEG / 2 && v + GAP * k > best) {
          best = v + GAP * k
          bestK = k
        }
      }
      if (tl[j] !== q[i]) continue
      const b = 1 + bonus(t, j)
      let cell = NEG
      let src = -1
      const prev = dp[(i - 1) * n + j - 1]!
      if (prev > NEG / 2) {
        cell = prev + CONSECUTIVE
        src = j - 1
      }
      if (bestK >= 0 && best - GAP * (j - 1) > cell) {
        cell = best - GAP * (j - 1)
        src = bestK
      }
      if (src >= 0) {
        dp[i * n + j] = cell + b
        from[i * n + j] = src
      }
    }
  }
  let bj = -1
  let bs = NEG
  for (let j = 0; j < n; j++) {
    const v = dp[(m - 1) * n + j]!
    if (v > bs) {
      bs = v
      bj = j
    }
  }
  if (bj < 0) return null
  const idx = new Array<number>(m)
  for (let i = m - 1, j = bj; i >= 0; i--) {
    idx[i] = j
    j = from[i * n + j]!
  }
  let score = bs - n * 0.05
  if (idx.every((x, k) => x === k)) score += 10 // a prefix
  if (m === n) score += 20 // the whole text
  return { score, idx }
}

export type Field = { text: string; weight: number }

/**
 * Matches every word of the query (all must match) against the fields; each word counts its best
 * field. `idx` are the first field's (the title's) matched positions, for highlighting.
 */
export function fuzzyFields(query: string, fields: Field[]): Match | null {
  const words = query.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { score: 0, idx: [] }
  let score = 0
  const hit = new Set<number>()
  for (const w of words) {
    let best: number | null = null
    fields.forEach((f, fi) => {
      if (!f.text) return
      const r = fuzzyMatch(w, f.text)
      if (!r) return
      if (fi === 0) r.idx.forEach((x) => hit.add(x))
      const s = r.score * f.weight
      if (best === null || s > best) best = s
    })
    if (best === null) return null
    score += best
  }
  return { score, idx: [...hit].sort((a, b) => a - b) }
}

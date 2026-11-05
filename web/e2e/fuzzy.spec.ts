import { expect, test } from '@playwright/test'
import { fuzzyFields, fuzzyMatch } from '../src/lib/fuzzy'

// The palette's matcher, on its own (no server).

test('a query matches only as a subsequence, any case', () => {
  expect(fuzzyMatch('nsn', 'New session')).not.toBeNull()
  expect(fuzzyMatch('NS', 'new session')).not.toBeNull()
  expect(fuzzyMatch('sn', 'new session')).not.toBeNull()
  expect(fuzzyMatch('xz', 'new session')).toBeNull()
  expect(fuzzyMatch('ssw', 'new session')).toBeNull()
})

test('it reports the matched positions', () => {
  expect(fuzzyMatch('ns', 'New session')!.idx).toEqual([0, 4])
})

test('prefix beats word start beats scattered', () => {
  const prefix = fuzzyMatch('set', 'Settings')!.score
  const word = fuzzyMatch('set', 'Open Settings')!.score
  const scattered = fuzzyMatch('set', 'Show keyboard shortcuts text')!.score
  expect(prefix).toBeGreaterThan(word)
  expect(word).toBeGreaterThan(scattered)
})

test('consecutive and shorter targets score higher', () => {
  expect(fuzzyMatch('abc', 'abcxx')!.score).toBeGreaterThan(fuzzyMatch('abc', 'axbxc')!.score)
  expect(fuzzyMatch('mail', 'mail')!.score).toBeGreaterThan(fuzzyMatch('mail', 'mailbox settings')!.score)
})

test('every word of the query must match some field; the title decides the highlight', () => {
  const fields = [
    { text: 'Pick a database', weight: 1 },
    { text: '', weight: 0.7 },
    { text: 'alpha', weight: 0.6 },
  ]
  const m = fuzzyFields('pick alp', fields)
  expect(m).not.toBeNull()
  expect(m!.idx).toEqual([0, 1, 2, 3])
  expect(fuzzyFields('pick zzz', fields)).toBeNull()
})

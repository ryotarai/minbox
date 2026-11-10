/**
 * A tiny marker shared by the minbox Pi extensions in one Pi process (minbox.ts and subagent.ts).
 *
 * minbox.ts treats Pi as working until agent_settled, but gives up on a turn that shows no sign of
 * life for BUSY_STALE_MS (it assumes an agent_settled was missed). A long minbox_subagent run
 * produces few Pi events of its own, so subagent.ts calls touchBusy() on every child event (and on a
 * heartbeat) and minbox.ts counts a changed `busySeq()` as a sign of life.
 *
 * Pi loads each extension separately, so the counter lives on globalThis under a Symbol.for key and
 * does not depend on this module being instantiated once. It is a counter, not a time, so the
 * reader's clock (a fake one in tests) does not matter.
 */
const KEY = Symbol.for('minbox.pi.busy')

type Marker = { seq: number }

function marker(): Marker {
  const g = globalThis as any
  return (g[KEY] ??= { seq: 0 })
}

/** Something is alive (a subagent produced output, or a heartbeat fired). */
export function touchBusy(): void {
  marker().seq++
}

/** Changes whenever touchBusy() was called. */
export function busySeq(): number {
  return marker().seq
}

import type { WriteHeldState, WriteHoldHandle } from '@bananapus/nana-sdk-core/review'

/** A write held outside any flow's own dialog (an authority call, a Safe batch), shown app-wide with its exit. */
export type ShownHeldWrite = { chainId: number; hold: WriteHoldHandle; state: WriteHeldState }

const shownHeld = new Map<string, ShownHeldWrite>()
const heldListeners = new Set<() => void>()
let heldSnapshot: ShownHeldWrite[] = []

function heldChanged() {
  heldSnapshot = [...shownHeld.values()]
  for (const listener of heldListeners) listener()
}

/** Show a held write app-wide, by its saved attempt; a newer state of it replaces the older. */
export function showHeldWrite(chainId: number, hold: WriteHoldHandle, state: WriteHeldState): void {
  shownHeld.set(state.record.id, { chainId, hold, state })
  heldChanged()
}

/** Stop showing a held write, once it ended or its exit was taken. */
export function forgetHeldWrite(id: string): void {
  if (shownHeld.delete(id)) heldChanged()
}

export function subscribeHeldWrites(listener: () => void): () => void {
  heldListeners.add(listener)
  return () => { heldListeners.delete(listener) }
}

/** Every write shown as held app-wide. */
export function heldWritesSnapshot(): ShownHeldWrite[] {
  return heldSnapshot
}


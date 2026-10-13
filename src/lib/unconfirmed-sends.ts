import type { usePublicClient } from 'wagmi'

type Client = NonNullable<ReturnType<typeof usePublicClient>>

/** One lookup this often per unconfirmed send, for as long as the page is open. */
export const UNCONFIRMED_POLL_INTERVAL_MS = 20_000

export type UnconfirmedSend = { hash: `0x${string}`; chainId: number }

const sends = new Map<string, UnconfirmedSend & { stop: () => void }>()
const listeners = new Set<() => void>()
let version = 0

function changed() {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeUnconfirmedSends(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A snapshot that changes whenever a send is added or lifted. */
export function unconfirmedSendsVersion(): number {
  return version
}

export function unconfirmedSend(key: string): UnconfirmedSend | undefined {
  return sends.get(key)
}

/** A send's lock lifts when its receipt is read. Nothing else lifts it. */
export function liftUnconfirmedSend(key: string): void {
  const entry = sends.get(key)
  if (!entry) return
  entry.stop()
  sends.delete(key)
  changed()
}

/**
 * Hold an exact call against a repeat while the receipt of its sent
 * transaction is unread. The entry and its polling live here, in memory and
 * outside any component, so closing the dialog that unmounted the sending hook
 * does not release it. A page reload does; durable recovery is the SDK's.
 */
export function holdUnconfirmedSend(key: string, send: UnconfirmedSend, client: Client): void {
  if (sends.has(key)) return
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const poll = () => {
    if (typeof client.getTransactionReceipt !== 'function') return
    void client
      .getTransactionReceipt({ hash: send.hash })
      .then(found => {
        if (stopped) return
        if (found) liftUnconfirmedSend(key)
        else schedule()
      })
      .catch(() => {
        if (!stopped) schedule()
      })
  }
  const schedule = () => {
    timer = setTimeout(poll, UNCONFIRMED_POLL_INTERVAL_MS)
  }
  sends.set(key, {
    ...send,
    stop: () => {
      stopped = true
      clearTimeout(timer)
    },
  })
  schedule()
  changed()
}

/** Test seam: forget every held send without waking any hook that still shows one. */
export function clearUnconfirmedSends(): void {
  for (const entry of sends.values()) entry.stop()
  sends.clear()
}

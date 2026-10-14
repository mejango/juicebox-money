'use client'

import { useState, useSyncExternalStore } from 'react'
import type { WriteHoldState } from '@bananapus/nana-sdk-core/review'
import { WriteHeldNotice } from '@/components/ui/WriteHeldNotice'
import { useWriteHoldWatch } from '@/hooks/useWriteHoldWatch'
import { publicClient } from '@/lib/wallet-core'
import {
  forgetHeldWrite,
  heldWritesSnapshot,
  repeatsWithoutExit,
  showHeldWrite,
  subscribeHeldWrites,
  WRITE_RELEASED_LINE,
  type ShownHeldWrite,
} from '@/lib/write-holds'
import type { JBChainId } from '@bananapus/nana-sdk-core'

/**
 * Writes held outside a flow's own dialog (authority calls, Safe batches),
 * shown app-wide: each with the hold's line and, when a fresh look at the
 * chain offers it, the exit. After the exit the user starts the action again.
 */
export function HeldWritesNotice() {
  const held = useSyncExternalStore(subscribeHeldWrites, heldWritesSnapshot, () => [])
  if (!held.length) return null
  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))] space-y-2" role="status">
      {held.map(item => <HeldWrite key={item.state.record.id} item={item} />)}
    </div>
  )
}

function HeldWrite({ item }: { item: ShownHeldWrite }) {
  const client = publicClient(item.chainId as JBChainId)
  const [ended, setEnded] = useState<string | null>(null)
  const id = item.state.record.id
  const show = (state: WriteHoldState) => {
    if (state.status === 'clear') forgetHeldWrite(id)
    else if (state.record.id === id && !repeatsWithoutExit(item.state, state)) showHeldWrite(item.chainId, item.hold, state)
  }
  useWriteHoldWatch(item.hold, client as never, show)
  const exit = async () => {
    const { released, state } = await item.hold.exit(item.state, { checkedWallet: true }, client as never)
    if (released) forgetHeldWrite(id)
    else if (state.status === 'clear') setEnded(WRITE_RELEASED_LINE)
    else show(state)
  }
  return (
    <div className="rounded-xl border border-smoke-300 bg-bone p-3 text-sm shadow-lg">
      {ended ? (
        <p className="flex items-start justify-between gap-3">
          <span>{ended}</span>
          <button type="button" className="text-xs underline" onClick={() => forgetHeldWrite(id)}>Close</button>
        </p>
      ) : (
        <WriteHeldNotice chainId={item.chainId} state={item.state} onExit={item.state.exit ? () => void exit() : undefined} />
      )}
    </div>
  )
}

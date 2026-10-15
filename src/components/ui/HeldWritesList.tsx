'use client'

import { HeldWritesNotice, useHeldWrites } from '@bananapus/nana-sdk-core/review/react'
import type { WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { publicClient } from '@/lib/wallet-core'
import { writeHolds } from '@/lib/write-holds'

/** The SDK's held-write notice for each supported chain (HeldWritesNotice loads it). */
export default function HeldWritesList({ account }: { account: Address }) {
  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))] space-y-2">
      {SUPPORTED_CHAINS.map(chain => <ChainHeldWrites key={chain.id} chainId={chain.id} account={account} />)}
    </div>
  )
}

function ChainHeldWrites({ chainId, account }: { chainId: number; account: Address }) {
  const client = publicClient(chainId as JBChainId) as unknown as WriteHoldClient
  // Only what needs the user: a write that is only confirming shows in its own flow.
  const items = useHeldWrites({ hold: writeHolds, chainId, account, client }).filter(item => item.view.phase === 'held')
  return (
    <HeldWritesNotice
      items={items}
      className="held-writes-notice space-y-2 rounded-xl border border-smoke-300 bg-bone p-3 text-sm text-smoke-800 shadow-lg"
    />
  )
}

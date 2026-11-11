'use client'

import { useState } from 'react'
import { HeldWritesNotice, useHeldWrites, type HeldWriteItem } from '@bananapus/nana-sdk-core/review/react'
import { HELD_HASH_MISMATCH_LINE, HELD_HASH_UNVERIFIED_LINE, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { isHash, type Address } from 'viem'
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
  // Every background write, in whatever state it is: confirming, held, settled or released.
  const items = useHeldWrites({ hold: writeHolds, chainId, account, client })
  // A held write the wallet sent without returning its hash: the user can give it, when the hold can check it.
  const unhashed = items.filter(item => item.view.state?.status === 'held-no-hash' &&
    writeHolds.list({ account, chainId }).some(({ key, record }) => key === item.key && record.nonce !== undefined && record.fromBlock !== undefined))
  return (
    <>
      <HeldWritesNotice
        items={items}
        className="held-writes-notice space-y-2 rounded-xl border border-smoke-300 bg-bone p-3 text-sm text-smoke-800 shadow-lg"
      />
      {unhashed.map(item => <HeldHashInput key={item.key} item={item} account={account} chainId={chainId} client={client} />)}
    </>
  )
}

/** The hash of a held write whose wallet reply was lost: the hold attaches it only when it is this exact send. */
function HeldHashInput({ item, account, chainId, client }: { item: HeldWriteItem; account: Address; chainId: number; client: WriteHoldClient }) {
  const [hash, setHash] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The hold took the hash: its line follows that transaction from here. */
  const [attached, setAttached] = useState(false)
  const id = `held-hash-${item.key}`
  const check = async () => {
    const value = hash.trim()
    if (!isHash(value)) return setError('Enter a complete transaction hash.')
    const handle = writeHolds.list({ account, chainId }).find(({ key }) => key === item.key)?.handle
    if (!handle) return
    setBusy(true)
    setError(null)
    try {
      const { hashCheck } = await handle.attachHash(client, value)
      if (hashCheck === 'attached') return setAttached(true)
      setError(hashCheck === 'mismatch' ? HELD_HASH_MISMATCH_LINE : HELD_HASH_UNVERIFIED_LINE)
    } finally { setBusy(false) }
  }
  if (attached) return null
  return (
    <div className="space-y-2 rounded-xl border border-smoke-300 bg-bone p-3 text-sm text-smoke-800 shadow-lg">
      <label htmlFor={id} className="block">Transaction hash, if the wallet reply was lost</label>
      <input id={id} className="input-well w-full px-3 py-2 font-mono text-xs" placeholder="0x…" value={hash} onChange={event => setHash(event.target.value)} />
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" className="btn-secondary min-h-[44px] px-4 text-sm" disabled={busy || !hash.trim()} onClick={() => void check()}>
        Check existing transaction
      </button>
    </div>
  )
}

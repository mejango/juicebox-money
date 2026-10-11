'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { PayPanel } from '@/components/project/PayPanel'
import { ShopTab } from '@/components/project/ShopTab'
import { ShopCartProvider } from '@/components/project/ShopCartProvider'
import { shop721QueryKey, type Shop } from '@/hooks/useShop721'

/** Browser-only native inventory fixture; no public-chain transactions. */
export default function DefifaInventoryProof() {
  const client = useQueryClient()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const shop: Shop = {
      protocol: 'defifa', hook: '0x1111111111111111111111111111111111111111',
      capabilities: { genericPay: false, genericCashOut: false, manageTiers: false },
      cashOutEnabled: false, transfersPaused: null, transferPauseByStage: null,
      configFlags: null, phase: 4,
      pricing: { currency: 1, decimals: 6, symbol: 'USDC' },
      tiers: ['Rekt', 'FUD', 'Copium', 'Crab', 'Hopium', 'FOMO', 'Moon'].map((name, index) => ({
        id: index + 1, name, currentSupply: BigInt(index), price: 1250000n,
        remaining: 100, initial: 100, category: 0, discountPercent: 0,
        reserveFrequency: 0, votingUnits: 0n, splitPercent: 0,
        encodedIpfsUri: `0x${'0'.repeat(64)}`, resolvedUri: '',
      })),
    }
    client.setQueryData(shop721QueryKey(1, 1, false), shop)
    client.setQueryData(['payNftProtocol', 1, 1, false], { protocol: 'defifa' })
    setReady(true)
  }, [client])
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8" data-defifa-ready={ready}>
    <h1 className="font-agrandir text-2xl">Native market inventory</h1>
    {ready ? <ShopCartProvider>
      <section aria-label="Payment surface"><PayPanel chainId={1} projectId={1} projectName="Fixture" isRevnet={false} chains={[[1, 1]]} /></section>
      <section aria-label="NFT inventory"><ShopTab chainId={1} projectId={1} isRevnet={false} chains={[[1, 1]]} /></section>
    </ShopCartProvider> : null}
  </main>
}

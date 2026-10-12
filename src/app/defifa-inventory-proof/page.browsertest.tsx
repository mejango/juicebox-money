'use client'

import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ProjectFlavor } from '@/components/project/ProjectFlavor'
import { PayPanel } from '@/components/project/PayPanel'
import { ShopTab } from '@/components/project/ShopTab'
import { ShopCartProvider } from '@/components/project/ShopCartProvider'
import { tierMediaImageUrl, parseTierMetadataJson, pickTierMetadata } from '@bananapus/nana-sdk-core/v6'
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
      configFlags: null, phase: new URLSearchParams(window.location.search).get('phase') === 'mint' ? 1 : 4,
      pricing: { currency: 1, decimals: 6, symbol: 'USDC' },
      tiers: ['Home team', 'Away team', 'Draw', 'Blue team', 'Red team', 'Green team', 'Gold team'].map((name, index) => ({
        id: index + 1, name, currentSupply: BigInt(index), price: index % 2 === 0 ? 1250000n : 2750000n,
        remaining: 100, initial: 100, category: 0, discountPercent: 0,
        reserveFrequency: 0, votingUnits: 0n, splitPercent: 0,
        encodedIpfsUri: `0x${'0'.repeat(64)}`, resolvedUri: `data:application/json;base64,${btoa(JSON.stringify({ name: 'Cosmetic name', image: `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#274ff5"/><text x="12" y="55" fill="white">NFT ${index + 1}</text></svg>`)}` }))}`,
      })),
    }
    const replay = (window as Window & { __recordedNftArt?: { name: string; resolvedUri: string } }).__recordedNftArt
    const ordinary = new URLSearchParams(window.location.search).get('presentation') === 'ordinary'
    if (replay) shop.tiers = shop.tiers.slice(0, 2).map(tier => ({ ...tier, name: `${replay.name} / tier ${tier.id}`, resolvedUri: replay.resolvedUri }))
    if (ordinary) {
      shop.protocol = 'jb721'
      client.setQueryData(['payShop', 1, 1, false], {
        tiersComplete: true, hook: shop.hook, idTarget: shop.hook, pricingCurrency: 1, pricingDecimals: 6,
        tiers: shop.tiers.map(tier => ({ ...tier, unlimited: false, cantBuyWithCredits: false, description: null,
          image: tierMediaImageUrl(pickTierMetadata(parseTierMetadataJson(tier.resolvedUri!) ?? {})?.image) ?? null })),
      })
    }
    client.setQueryData(shop721QueryKey(1, 1, false), shop)
    client.setQueryData(['payNftProtocol', 1, 1, false], { protocol: shop.protocol })
    setReady(true)
  }, [client])
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8" data-defifa-ready={ready}>
    <h1 className="font-agrandir text-2xl">NFT checkout fixture</h1>
    <p className="text-sm text-smoke-600">Fixture checkout state. Any injected recorded artwork is a historical URI replay, not a live purchase.</p>
    {ready && <p>Flavor: <ProjectFlavor chainId={1} projectId={1} isRevnet={false} /></p>}
    {ready ? <ShopCartProvider>
      <section aria-label="Payment surface"><PayPanel chainId={1} projectId={1} projectName="Fixture" isRevnet={false} chains={[[1, 1]]} /></section>
      <section aria-label="NFT inventory"><ShopTab chainId={1} projectId={1} isRevnet={false} chains={[[1, 1]]} /></section>
    </ShopCartProvider> : null}
  </main>
}

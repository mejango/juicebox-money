'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { useQuery } from '@tanstack/react-query'
import type { Address, PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { PERSIST } from '@/lib/query-persist'

/*
 * The project's 721 shop reads, shared by the Shop tab, the pay box and activity rows. Kept out
 * of ShopTab so the home activity rail can name an item without pulling the tab and its modals
 * onto the initial route.
 */

export type ShopTierFlags = {
  allowOwnerMint: boolean
  transfersPausable: boolean
  cantBeRemoved: boolean
  cantIncreaseDiscountPercent: boolean
  cantBuyWithCredits: boolean
}


export type ShopConfigFlags = {
  preventOverspending: boolean
  noNewTiersWithReserves: boolean
  noNewTiersWithVotes: boolean
  noNewTiersWithOwnerMinting: boolean
  issueTokensForSplits: boolean
}


export type ShopTier = {
  id: number
  /** Full (undiscounted) price in the shop's pricing terms. */
  price: bigint
  remaining: number
  initial: number
  category: number
  /** Out of the SDK's 200-point discount denominator. */
  discountPercent: number
  reserveFrequency: number
  votingUnits: bigint
  /** Share of each sale paid out to the tier's split group, out of SPLITS_TOTAL_PERCENT. */
  splitPercent: number
  encodedIpfsUri: `0x${string}`
  /** tokenUriResolver output (tiersOf includeResolvedUri=true); '' if none. */
  resolvedUri: string
  /** Stored tier flags (store tiersOf); undefined if the read failed. */
  flags?: ShopTierFlags
}


export type Shop = {
  hook: Address
  /** Shared implementation address used to key 721 hook metadata. */
  idTarget: Address
  cashOutEnabled: boolean
  /** Whether the current ruleset has the 721 transfer-pause bit enabled. */
  transfersPaused: boolean | null
  /**
   * Whether each stage pauses transfers, oldest first. Only read for a revnet, whose
   * stages are queued once at deployFor and can never be requeued — so this is the
   * settled schedule rather than a reading of the current moment. Null elsewhere,
   * where a future ruleset really can still change the answer.
   */
  transferPauseByStage: { stage: number; paused: boolean }[] | null
  pricing: { currency: number; decimals: number; symbol: string }
  tiers: ShopTier[]
  configFlags: ShopConfigFlags | null
}


export type TierMedia = {
  name?: string
  description?: string
  image?: string
  animationUrl?: string
  mediaType?: string
  categoryName?: string
}


/** The project's 721 shop, shared by the tab, the pay box, and activity rows (one query key). */
export function useShop721(chainId: JBChainId, projectId: number, isRevnet: boolean) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const nativeSymbol = JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH'
  return useQuery({
    queryKey: ['shop721', chainId, projectId, isRevnet],
    meta: PERSIST,
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    // The reads load on demand, so the home activity rail stays light.
    queryFn: async () =>
      (await import('@/lib/shop-read')).readShop(publicClient!, chainId, projectId, isRevnet, nativeSymbol),
  })
}

/**
 * Tier display metadata (name/image/category name), resolved from the
 * onchain resolver's data URI or the tier's IPFS JSON. Best-effort — cards
 * render immediately and hydrate as this lands.
 * The tier set the media was resolved FROM is part of the identity: keyed on
 * the hook alone, an infinite-staleTime persisted entry survives reloads, so
 * tiers added from anywhere but this browser rendered as "Item #N" forever.
 */
export function useShop721Media(chainId: JBChainId, shop: Shop | null | undefined) {
  const mediaTierKey = (shop?.tiers ?? [])
    .map(tier => `${tier.id}:${tier.encodedIpfsUri}:${tier.resolvedUri}`)
    .join(',')
  return useQuery({
    queryKey: ['shop721Media', chainId, shop?.hook, mediaTierKey],
    meta: PERSIST,
    enabled: !!shop && shop.tiers.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const { resolveTierMedia } = await import('@/lib/shop-read')
      const entries = await Promise.all(
        shop!.tiers.map(
          async tier => [tier.id, await resolveTierMedia(tier)] as const,
        ),
      )
      return Object.fromEntries(entries) as Record<number, TierMedia>
    },
  })
}

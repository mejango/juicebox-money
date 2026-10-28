'use client'

import { useKeptQuery } from '@/hooks/useKeptQuery'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
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
  name?: string
  currentSupply?: bigint
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
  /** SDK-authenticated native store/snapshot, used only for cosmetic URI reads. */
  store?: Address
  inventoryBlockNumber?: bigint
  /** Shared implementation address used to key 721 hook metadata. */
  idTarget?: Address
  protocol?: 'jb721' | 'defifa'
  capabilities?: { genericPay: boolean; genericCashOut: boolean; manageTiers: boolean }
  phase?: number
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

export type ShopMediaResult = {
  media: Record<number, TierMedia>
  failedTierIds: number[]
}


export const SHOP_721_QUERY_PREFIX = ['shop721-v2'] as const
export const DEFIFA_HOLDINGS_QUERY_PREFIX = ['defifa-owned-nfts'] as const
export const NFT_CHECKOUT_PREVIEW_PAGE_SIZE = 12

export function shop721QueryKey(chainId: JBChainId, projectId: number, isRevnet: boolean) {
  return [...SHOP_721_QUERY_PREFIX, chainId, projectId, isRevnet] as const
}

/** The project's 721 shop, shared by the tab, the pay box, and activity rows (one query key). */
export function useShop721(chainId: JBChainId, projectId: number, isRevnet: boolean) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const nativeSymbol = JB_CHAINS[chainId]?.nativeTokenSymbol ?? 'ETH'
  return useKeptQuery({
    queryKey: shop721QueryKey(chainId, projectId, isRevnet),
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
export function useShop721Media(chainId: JBChainId, shop: Shop | null | undefined, nativeTierIds?: readonly number[]) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const tiers = nativeTierIds ? (shop?.tiers ?? []).filter(tier => nativeTierIds.includes(tier.id)).slice(0, NFT_CHECKOUT_PREVIEW_PAGE_SIZE) : shop?.tiers ?? []
  const mediaTierKey = tiers
    .map(tier => `${tier.id}:${tier.encodedIpfsUri}:${tier.resolvedUri}${tier.name === undefined ? '' : `:${tier.name}`}`)
    .join(',')
  const query = useKeptQuery<ShopMediaResult>({
    // Old persisted maps could contain a failed fetch cached as a valid {}.
    queryKey: ['shop721Media', 2, chainId, shop?.hook, nativeTierIds === undefined
      ? mediaTierKey : JSON.stringify(['preview', shop?.store, shop?.inventoryBlockNumber?.toString(), mediaTierKey])],
    meta: PERSIST,
    enabled: !!shop && tiers.length > 0 && (!nativeTierIds || !shop.store || !!publicClient || tiers.every(tier => !!tier.resolvedUri)),
    staleTime: query => query.state.data?.failedTierIds.length ? 0 : Infinity,
    queryFn: async ({ client, queryKey }): Promise<ShopMediaResult> => {
      const previous = client.getQueryData<ShopMediaResult>(queryKey)?.media
      const { resolveShopMedia, resolveNativeShopMedia } = await import('@/lib/shop-read')
      if (nativeTierIds && shop?.protocol === 'defifa') {
        return resolveNativeShopMedia(publicClient, shop, tiers, previous)
      }
      return resolveShopMedia(tiers, previous)
    },
  })
  return {
    ...query,
    data: query.data?.media,
    hasFailures: query.isError || !!query.data?.failedTierIds.length,
  }
}

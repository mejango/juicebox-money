'use client'

import {
  JB_CHAINS,
  JBOmnichainDeployerContracts,
  jb721TiersHookAbi,
  jb721TiersHookStoreAbi,
  jbContractAddress,
  jbOmnichainDeployerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  decode721RulesetMetadata,
  DISCOUNT_DENOMINATOR,
  effectiveTierPrice,
  getAccountingContexts,
  getCurrentRuleset,
  getProject721Shop,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import { hasPermissions, JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { AddressLink } from '@/components/ui/AddressLink'
import {
  CustomerCardSkeleton,
  FormFieldsSkeleton,
  ShopTabSkeleton,
} from '@/components/LoadingSkeletons'
import { Skeleton, SkeletonTable } from '@/components/ui/Skeleton'
import { readAllActiveTiers, readTierPage } from '@/lib/shop-tiers'
import {
  AddShopItemsModal,
  type ShopWriteTarget,
} from '@/components/project/AddShopItemsModal'
import {
  RedeemShopItemsModal,
  type RedeemableShopTarget,
} from '@/components/project/RedeemShopItemsModal'
import { MintShopItemModal } from '@/components/project/MintShopItemModal'
import { ReplaceTierMediaModal } from '@/components/project/ReplaceTierMediaModal'
import { SubTabs } from '@/components/project/Tabs'
import { useShopCart } from '@/components/project/ShopCartProvider'
import {
  ModalCloseButton,
  ModalDialog,
  ModalShell,
} from '@/components/ui/ModalShell'
import { QuantityStepper } from '@/components/ui/QuantityStepper'
import { useWallet } from '@/hooks/useWallet'
import { useViewedAccount } from '@/hooks/useViewedAccount'
import type {
  BsOwnedShopItem,
  BsShopPurchase,
  BsShopRows,
} from '@/lib/bendystraw'
import {
  appIpfsUrl,
  formatTokenAmount,
  timeAgo,
} from '@/lib/format'
import { bytes32ToCidV0 } from '@bananapus/nana-sdk-core'
import {
  TIER_UNLIMITED_SUPPLY,
  parseTierMetadataJson,
  pickTierMetadata,
  tierMediaAssetUrl,
  tierMediaImageUrl,
} from '@/lib/tier-metadata'
import { tokenSymbol } from '@/lib/token-symbol'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'
import { PERSIST } from '@/lib/query-persist'
import { SPLIT_SALES_TOKEN_CREDIT_TITLE } from '@/lib/shop-copy'
import { explorerTxUrl } from '@/lib/chainDisplay'

/**
 * Shop tab (website/ parity: renderShopSection) — the project's 721 tiers,
 * plus the owner/operator flow for adding new items. A shared cart connects
 * this inventory to the Pay card's checkout.
 *
 * Hook/store/metadata/pricing/tier resolution comes from the shared SDK's
 * getProject721Shop helper, so Pay and Shop use the same revnet, custom, and
 * omnichain rules. RPC failures surface as errors, never as "no shop".
 */

type ShopTierFlags = {
  allowOwnerMint: boolean
  transfersPausable: boolean
  cantBeRemoved: boolean
  cantIncreaseDiscountPercent: boolean
  cantBuyWithCredits: boolean
}

type ShopConfigFlags = {
  preventOverspending: boolean
  noNewTiersWithReserves: boolean
  noNewTiersWithVotes: boolean
  noNewTiersWithOwnerMinting: boolean
  issueTokensForSplits: boolean
}

const SHOP_CONFIG_ROWS: [keyof ShopConfigFlags, string][] = [
  ['preventOverspending', 'Require exact payment'],
  ['noNewTiersWithReserves', 'Lock reserved items after launch'],
  ['noNewTiersWithVotes', 'Lock voting items after launch'],
  ['noNewTiersWithOwnerMinting', 'Lock owner minting after launch'],
  ['issueTokensForSplits', SPLIT_SALES_TOKEN_CREDIT_TITLE],
]

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`

type ShopTier = {
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
  encodedIpfsUri: `0x${string}`
  /** tokenUriResolver output (tiersOf includeResolvedUri=true); '' if none. */
  resolvedUri: string
  /** Stored tier flags (store tiersOf); undefined if the read failed. */
  flags?: ShopTierFlags
}

/**
 * Shopper-facing copy for each stored tier flag (revnet-app parity).
 *
 * Parameterized on `isRevnet` because this tab renders for non-revnet projects too, where the
 * free-mint gate is the project OWNER plus MINT_721 and there is no revnet operator at all —
 * the same distinction MintShopItemModal already draws.
 */
const flagDescriptions = (
  isRevnet: boolean,
): [keyof ShopTierFlags, string, string][] => [
  [
    'allowOwnerMint',
    `${isRevnet ? 'Revnet operator' : 'Project owner'} can mint`,
    `The ${isRevnet ? 'revnet operator' : 'project owner'}, or an address with the MINT_721 permission, can mint this item for free, without a payment.`,
  ],
  [
    'transfersPausable',
    'Ruleset-controlled transfers',
    'The active ruleset can pause transfers of this item. Minting and burning remain available.',
  ],
  [
    'cantBeRemoved',
    'Cannot be removed',
    'This item can never be removed from the shop.',
  ],
  [
    'cantIncreaseDiscountPercent',
    'Discount capped',
    "This item's discount can only be lowered, never increased.",
  ],
  [
    'cantBuyWithCredits',
    'No credit buys',
    "Buyers can't use shop credits to mint this item — only a fresh payment.",
  ],
]

type Shop = {
  hook: Address
  /** Shared implementation address used to key 721 hook metadata. */
  idTarget: Address
  cashOutEnabled: boolean
  /** Whether the current ruleset has the 721 transfer-pause bit enabled. */
  transfersPaused: boolean | null
  pricing: { currency: number; decimals: number; symbol: string }
  tiers: ShopTier[]
  configFlags: ShopConfigFlags | null
}

type TierMedia = {
  name?: string
  description?: string
  image?: string
  animationUrl?: string
  mediaType?: string
  categoryName?: string
}

export function ShopTab({
  chainId,
  projectId,
  isRevnet,
  chains,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  /** [chain id, project id] for every linked deployment. Required: the old
   *  single-deployment default silently degraded every cross-chain view to one chain, with
   *  nothing to distinguish that from a genuinely single-chain project. */
  chains: [number, number][]
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { address } = useViewedAccount()
  const { quantities: cart, count: cartCount } = useShopCart()
  const chainMeta = JB_CHAINS[chainId]
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

  const [category, setCategory] = useState<number | null>(null)
  const [addItemsOpen, setAddItemsOpen] = useState(false)
  const [detailTierId, setDetailTierId] = useState<number | null>(null)
  const [mintTierId, setMintTierId] = useState<number | null>(null)
  const [replaceTierId, setReplaceTierId] = useState<number | null>(null)

  const {
    data: shop,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['shop721', chainId, projectId, isRevnet],
    meta: PERSIST,
    enabled: !!publicClient,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      readShop(publicClient!, chainId, projectId, isRevnet, nativeSymbol),
  })

  // Collection name/symbol — the 721 hook is itself the collection contract.
  const { data: collectionMeta } = useReadContracts({
    contracts: [
      {
        abi: jb721TiersHookAbi,
        address: shop?.hook,
        functionName: 'name',
        chainId,
      },
      {
        abi: jb721TiersHookAbi,
        address: shop?.hook,
        functionName: 'symbol',
        chainId,
      },
    ],
    query: { enabled: !!shop, staleTime: 5 * 60_000 },
  })

  // Leftover pay credits the connected wallet can spend in the Pay box.
  const { data: credits } = useReadContract({
    abi: jb721TiersHookAbi,
    address: shop?.hook,
    functionName: 'payCreditsOf',
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!shop && !!address, staleTime: 30_000 },
  })

  // Tier display metadata (name/image/category name), resolved from the
  // onchain resolver's data URI or the tier's IPFS JSON. Best-effort — cards
  // render immediately and hydrate as this lands.
  // The tier set the media was resolved FROM is part of the identity: keyed on
  // the hook alone, an infinite-staleTime persisted entry survives reloads, so
  // tiers added from anywhere but this browser rendered as "Item #N" forever.
  const mediaTierKey = (shop?.tiers ?? [])
    .map(tier => `${tier.id}:${tier.encodedIpfsUri}:${tier.resolvedUri}`)
    .join(',')
  const { data: mediaById } = useQuery({
    queryKey: ['shop721Media', chainId, shop?.hook, mediaTierKey],
    meta: PERSIST,
    enabled: !!shop && shop.tiers.length > 0,
    staleTime: Infinity,
    queryFn: async () => {
      const entries = await Promise.all(
        shop!.tiers.map(
          async tier => [tier.id, await resolveTierMedia(tier)] as const,
        ),
      )
      return Object.fromEntries(entries) as Record<number, TierMedia>
    },
  })

  const categories = useMemo(() => {
    if (!shop) return []
    const ids = [...new Set(shop.tiers.map(tier => tier.category))].sort(
      (a, b) => a - b,
    )
    return ids.map(id => {
      const named = shop.tiers.find(
        tier => tier.category === id && mediaById?.[tier.id]?.categoryName,
      )
      return {
        id,
        name:
          (named && mediaById?.[named.id]?.categoryName) ||
          (id === 0 ? 'General' : `Category ${id}`),
      }
    })
  }, [shop, mediaById])

  const visibleTiers = useMemo(() => {
    if (!shop) return []
    return category === null
      ? shop.tiers
      : shop.tiers.filter(tier => tier.category === category)
  }, [shop, category])
  const cartTotal = useMemo(() => {
    if (!shop) return 0n
    return shop.tiers.reduce(
      (total, tier) =>
        total +
        effectiveTierPrice(tier.price, tier.discountPercent) *
          BigInt(cart[tier.id] ?? 0),
      0n,
    )
  }, [shop, cart])
  const detailTier =
    detailTierId == null
      ? null
      : shop?.tiers.find(tier => tier.id === detailTierId) ?? null
  const mintTier =
    mintTierId == null
      ? null
      : shop?.tiers.find(tier => tier.id === mintTierId) ?? null

  // Whether the viewer may edit item metadata here: the hook owner, or an
  // address holding SET_721_METADATA for the project.
  const { data: canEditMetadata = false } = useQuery({
    queryKey: ['shop721CanEditMetadata', chainId, shop?.hook, address],
    enabled: !!publicClient && !!shop && !!address,
    staleTime: 60_000,
    queryFn: async () => {
      if (!publicClient || !shop || !address) return false
      const owner = await publicClient.readContract({
        address: shop.hook,
        abi: jb721TiersHookAbi,
        functionName: 'owner',
      })
      if (owner.toLowerCase() === address.toLowerCase()) return true
      return hasPermissions(publicClient, {
        chainId,
        operator: address,
        account: owner,
        projectId: BigInt(projectId),
        permissionIds: [JBPermissionIdsV6.SET_721_METADATA],
      })
    },
  })

  // Resolve each linked collection only when the operator opens the editor.
  // Per-chain failures stay local so one flaky RPC does not hide the chains
  // that are ready to receive items.
  const {
    data: writeTargets,
    isLoading: writeTargetsLoading,
  } = useQuery({
    queryKey: ['shop721WriteTargets', chains, isRevnet],
    meta: PERSIST,
    enabled: (addItemsOpen || replaceTierId != null) && !!shop,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<ShopWriteTarget[]> =>
      (
        await resolveLinkedShops(
          chains,
          { chainId, projectId, shop: shop! },
          isRevnet,
        )
      ).map(resolved => ({
        chainId: resolved.chainId,
        projectId: resolved.projectId,
        hook: resolved.shop?.hook ?? null,
        pricing: resolved.shop?.pricing ?? null,
        error:
          resolved.failure === 'unreadable'
            ? 'Could not read this shop'
            : resolved.failure === 'no-shop'
              ? 'No shop on this chain'
              : undefined,
      })),
  })

  if (isLoading) return <ShopTabSkeleton />

  if (isError || !shop) {
    return (
      <div className="card p-5">
        <span className="field-label">Shop</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          {isError
            ? "Couldn't load the shop right now — try again in a moment."
            : `No store yet.${
                isRevnet
                  ? ' The operator can add items for supporters to buy.'
                  : ''
              }`}
        </p>
      </div>
    )
  }

  const collectionName = String(collectionMeta?.[0]?.result ?? '').trim()
  const collectionSymbol = String(collectionMeta?.[1]?.result ?? '').trim()

  const addItemsButton = (
    <button
      type="button"
      onClick={() => setAddItemsOpen(true)}
      className="text-sm font-medium text-bluebs-600 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-700"
    >
      + Add items
    </button>
  )

  // Shop managers are granted in the Owner tab's Permissions card, which nobody finds from here.

  const inventory = (
    <div className="space-y-5">
      {shop.tiers.length > 0 ? (
        <div className="flex justify-end">{addItemsButton}</div>
      ) : null}

      {!!address && shop.tiers.length > 0 && (credits ?? 0n) > 0n ? (
        <p className="callout callout-info text-sm">
          Your shop credit:{' '}
          <span className="font-medium">
            {formatTokenAmount(credits!, shop.pricing.decimals)}{' '}
            {shop.pricing.symbol}
          </span>{' '}
          — it&apos;s applied automatically when you buy.
        </p>
      ) : null}

      {shop.tiers.length === 0 ? (
        <div className="card p-5">
          <div>
            <p className="text-sm leading-relaxed text-smoke-700">
              No items in the shop yet.
            </p>
            <div className="mt-2">{addItemsButton}</div>
          </div>
        </div>
      ) : (
        <>
          {categories.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {[{ id: null as number | null, name: 'All' }, ...categories].map(
                cat => (
                  <button
                    key={cat.id ?? 'all'}
                    type="button"
                    onClick={() => setCategory(cat.id)}
                    aria-pressed={category === cat.id}
                    className={`min-h-[40px] rounded-lg border px-3.5 text-xs font-medium transition-colors focus-visible:outline-none ${
                      category === cat.id
                        ? 'border-bluebs-500 bg-bluebs-25 text-bluebs-700 shadow-[0_1px_4px_rgba(39,79,245,0.12)]'
                        : 'border-grey-300 bg-white text-grey-700 hover:border-bluebs-300 hover:text-bluebs-600'
                    }`}
                  >
                    {cat.name}
                  </button>
                ),
              )}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {visibleTiers.map(tier => (
              <TierCard
                key={tier.id}
                tier={tier}
                media={mediaById?.[tier.id]}
                pricing={shop.pricing}
                transfersPaused={
                  shop.transfersPaused && !!tier.flags?.transfersPausable
                }
                onOpen={() => setDetailTierId(tier.id)}
              />
            ))}
          </div>
        </>
      )}

      <div className="card p-5">
        <span className="field-label">Collection</span>
        <dl className="mt-2 space-y-1.5 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-smoke-700">Name</dt>
            <dd className="font-medium text-ink">
              {collectionName || 'Not yet named'}
              {collectionSymbol ? (
                <span className="ml-1.5 font-normal text-smoke-700">
                  ({collectionSymbol})
                </span>
              ) : null}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-smoke-700">Address</dt>
            <dd>
              <AddressLink
                address={shop.hook}
                chainId={chainId}
                className="text-ink"
              />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-smoke-700">Currency</dt>
            <dd className="font-medium text-ink">{shop.pricing.symbol}</dd>
          </div>
        </dl>
      </div>

      <ShopConfigDetails flags={shop.configFlags} />

      {addItemsOpen && writeTargetsLoading ? (
        <ShopEditorLoading onClose={() => setAddItemsOpen(false)} />
      ) : null}
      {addItemsOpen && !writeTargetsLoading && writeTargets ? (
        <AddShopItemsModal
          targets={writeTargets}
          activePricing={shop.pricing}
          existingCategories={categories}
          isRevnet={isRevnet}
          onClose={() => setAddItemsOpen(false)}
        />
      ) : null}

      {detailTier ? (
        <TierDetailModal
          isRevnet={isRevnet}
          chainId={chainId}
          chains={chains}
          tier={detailTier}
          media={mediaById?.[detailTier.id]}
          pricing={shop.pricing}
          transfersPaused={
            detailTier.flags?.transfersPausable
              ? shop.transfersPaused
              : false
          }
          onMint={
            detailTier.flags?.allowOwnerMint && detailTier.remaining > 0
              ? () => {
                  setDetailTierId(null)
                  setMintTierId(detailTier.id)
                }
              : undefined
          }
          onReplaceMedia={
            canEditMetadata
              ? () => {
                  setDetailTierId(null)
                  setReplaceTierId(detailTier.id)
                }
              : undefined
          }
          onClose={() => setDetailTierId(null)}
        />
      ) : null}

      {replaceTierId != null && shop ? (
        <ReplaceTierMediaModal
          chainId={chainId}
          hook={shop.hook}
          tierId={replaceTierId}
          current={mediaById?.[replaceTierId]}
          targets={writeTargets ?? null}
          isRevnet={isRevnet}
          onClose={() => setReplaceTierId(null)}
        />
      ) : null}

      {mintTier ? (
        <MintShopItemModal
          chainId={chainId}
          projectId={projectId}
          hook={shop.hook}
          tierId={mintTier.id}
          itemName={mediaById?.[mintTier.id]?.name ?? `Item #${mintTier.id}`}
          remaining={mintTier.remaining}
          isRevnet={isRevnet}
          onClose={() => setMintTierId(null)}
        />
      ) : null}

      {cartCount > 0 ? (
        <button
          type="button"
          onClick={() =>
            document
              .getElementById('project-pay-card')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
          className="fixed bottom-4 left-4 right-4 z-50 flex min-h-[52px] items-center justify-between rounded-xl bg-bluebs-600 px-5 text-sm font-medium text-white shadow-xl lg:hidden"
        >
          <span>
            Checkout, {cartCount} item{cartCount === 1 ? '' : 's'}
          </span>
          <span className="tabular-nums">
            {formatTokenAmount(cartTotal, shop.pricing.decimals)}{' '}
            {shop.pricing.symbol} →
          </span>
        </button>
      ) : null}
    </div>
  )

  return (
    <SubTabs
      hashParent="shop"
      tabs={[
        { label: 'Inventory', content: inventory },
        {
          label: 'Customers',
          content: (
            <ShopCustomers
              chainId={chainId}
              projectId={projectId}
              isRevnet={isRevnet}
              chains={chains}
              primaryShop={shop}
              mediaById={mediaById}
            />
          ),
        },
      ]}
    />
  )
}

function ShopConfigDetails({
  flags,
}: {
  flags: ShopConfigFlags | null
}) {
  return (
    <details className="card group p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-ink">
        <span>Shop config</span>
        <span
          aria-hidden="true"
          className="inline-block text-smoke-500 transition-transform group-open:rotate-90"
        >
          ▸
        </span>
      </summary>
      {flags ? (
        <dl className="mt-4 space-y-2 border-t border-smoke-200 pt-4 text-sm">
          {SHOP_CONFIG_ROWS.map(([key, label]) => (
            <div
              key={key}
              className="flex items-baseline justify-between gap-4"
            >
              <dt className="text-smoke-700">{label}</dt>
              <dd className="font-medium text-ink">
                {flags[key] ? 'On' : 'Off'}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-4 border-t border-smoke-200 pt-4 text-sm text-smoke-700">
          Couldn&apos;t read the current shop config.
        </p>
      )}
    </details>
  )
}

type LinkedShop = {
  chainId: JBChainId
  projectId: number
  shop: Shop
}

type ResolvedLinkedShop = {
  chainId: JBChainId
  projectId: number
  shop: Shop | null
  failure?: 'no-shop' | 'unreadable'
}

/**
 * Resolve the shop on every linked deployment, reusing the already-loaded
 * primary shop for the current chain. Per-chain failures stay local — one
 * flaky RPC never hides the chains that resolved.
 */
async function resolveLinkedShops(
  chains: [number, number][],
  primary: { chainId: JBChainId; projectId: number; shop: Shop },
  isRevnet: boolean,
): Promise<ResolvedLinkedShop[]> {
  return Promise.all(
    chains.map(async ([targetChainId, targetProjectId]) => {
      const targetId = targetChainId as JBChainId
      try {
        if (
          targetId === primary.chainId &&
          targetProjectId === primary.projectId
        ) {
          return {
            chainId: targetId,
            projectId: targetProjectId,
            shop: primary.shop,
          }
        }
        const client = getPublicClient(wagmiConfig, {
          chainId: targetId,
        }) as PublicClient | undefined
        if (!client) throw new Error('RPC unavailable')
        const targetChain = JB_CHAINS[targetId]
        const shop = await readShop(
          client,
          targetId,
          targetProjectId,
          isRevnet,
          targetChain?.nativeTokenSymbol ?? 'ETH',
        )
        return {
          chainId: targetId,
          projectId: targetProjectId,
          shop,
          failure: shop ? undefined : ('no-shop' as const),
        }
      } catch {
        return {
          chainId: targetId,
          projectId: targetProjectId,
          shop: null,
          failure: 'unreadable' as const,
        }
      }
    }),
  )
}

function projectsParam(chains: [number, number][]): string {
  return chains.map(([cid, pid]) => `${cid}:${pid}`).join(',')
}

async function fetchShopRows<T>(
  projects: string,
  owner?: Address,
): Promise<BsShopRows<T>> {
  const params = new URLSearchParams({ projects })
  if (owner) params.set('owner', owner)
  const response = await fetch(`/api/shop-customers?${params.toString()}`, {
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('Could not load shop activity.')
  return response.json() as Promise<BsShopRows<T>>
}

function ShopCustomers({
  chainId,
  projectId,
  isRevnet,
  chains,
  primaryShop,
  mediaById,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  chains: [number, number][]
  primaryShop: Shop
  mediaById: Record<number, TierMedia> | undefined
}) {
  const { openSignIn } = useWallet()
  const { address } = useViewedAccount()
  const [mounted, setMounted] = useState(false)
  const [redeemTargets, setRedeemTargets] = useState<
    RedeemableShopTarget[] | null
  >(null)
  useEffect(() => setMounted(true), [])
  const connected = mounted && !!address

  const projectKey = useMemo(() => projectsParam(chains), [chains])
  const names = useMemo(
    () =>
      Object.fromEntries(
        primaryShop.tiers.map(tier => [
          tier.id,
          mediaById?.[tier.id]?.name ?? `Item #${tier.id}`,
        ]),
      ) as Record<number, string>,
    [mediaById, primaryShop.tiers],
  )

  const purchases = useQuery({
    queryKey: ['shop-purchases', projectKey],
    meta: PERSIST,
    staleTime: 15_000,
    retry: 1,
    queryFn: () => fetchShopRows<BsShopPurchase>(projectKey),
  })
  const owned = useQuery({
    queryKey: ['shop-owned-items', projectKey, address],
    enabled: connected,
    staleTime: 15_000,
    retry: 1,
    queryFn: () => fetchShopRows<BsOwnedShopItem>(projectKey, address!),
  })

  // Resolve each chain's CURRENT shop and cash-out setting. Historical items
  // still appear in You, but only items from an active cash-out-enabled hook
  // can be offered to the terminal for redemption.
  const linkedShops = useQuery({
    queryKey: [
      'shop-linked-collections',
      projectKey,
      isRevnet,
      primaryShop.hook,
    ],
    enabled: connected && (owned.data?.items.length ?? 0) > 0,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<LinkedShop[]> =>
      (
        await resolveLinkedShops(
          chains,
          { chainId, projectId, shop: primaryShop },
          isRevnet,
        )
      ).flatMap(resolved =>
        resolved.shop
          ? [
              {
                chainId: resolved.chainId,
                projectId: resolved.projectId,
                shop: resolved.shop,
              },
            ]
          : [],
      ),
  })

  const redeemCandidatesKey = useMemo(() => {
    if (!address || !owned.data || !linkedShops.data) return ''
    return linkedShops.data
      .filter(linked => linked.shop.cashOutEnabled)
      .flatMap(linked =>
        owned.data.items
          .filter(
            item =>
              item.chainId === linked.chainId &&
              item.projectId === linked.projectId &&
              item.hook.toLowerCase() === linked.shop.hook.toLowerCase(),
          )
          .map(item => `${linked.chainId}:${linked.shop.hook}:${item.tokenId}`),
      )
      .sort()
      .join('|')
  }, [address, linkedShops.data, owned.data])

  // Verify current ownership in multicalls before showing the redeem action.
  // RedeemShopItemsModal repeats this immediately before every quote/send.
  const redeemable = useQuery({
    queryKey: ['shop-redeemable-items', address, redeemCandidatesKey],
    enabled: connected && redeemCandidatesKey.length > 0,
    staleTime: 15_000,
    retry: false,
    queryFn: async (): Promise<RedeemableShopTarget[]> => {
      if (!address || !owned.data || !linkedShops.data) return []
      const targets: RedeemableShopTarget[] = []
      for (const linked of linkedShops.data) {
        if (!linked.shop.cashOutEnabled) continue
        const candidates = owned.data.items.filter(
          item =>
            item.chainId === linked.chainId &&
            item.projectId === linked.projectId &&
            item.hook.toLowerCase() === linked.shop.hook.toLowerCase(),
        )
        if (!candidates.length) continue
        const client = getPublicClient(wagmiConfig, {
          chainId: linked.chainId,
        }) as PublicClient | undefined
        if (!client) continue
        const owners = await client.multicall({
          allowFailure: true,
          contracts: candidates.map(item => ({
            address: linked.shop.hook,
            abi: jb721TiersHookAbi,
            functionName: 'ownerOf' as const,
            args: [BigInt(item.tokenId)] as const,
          })),
        })
        const ownedItems = candidates
          .filter(
            (_, index) =>
              owners[index]?.status === 'success' &&
              String(owners[index]?.result).toLowerCase() ===
                address.toLowerCase(),
          )
          .map(item => ({ tokenId: item.tokenId, tierId: item.tierId }))
        const items = [
          ...new Map(
            ownedItems.map(item => [item.tokenId, item] as const),
          ).values(),
        ]
        if (items.length) {
          targets.push({
            chainId: linked.chainId,
            projectId: linked.projectId,
            hook: linked.shop.hook,
            idTarget: linked.shop.idTarget,
            items,
          })
        }
      }
      return targets
    },
  })

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <span className="field-label">You</span>
        {!connected ? (
          <div className="mt-2">
            <p className="text-sm leading-relaxed text-smoke-700">
              Sign in to see the items you own.
            </p>
            <button
              type="button"
              onClick={openSignIn}
              className="btn-primary mt-3 min-h-[40px] px-4 text-sm"
            >
              Sign in
            </button>
          </div>
        ) : owned.isLoading ? (
          <SkeletonTable rows={4} columns={2} className="mt-4" />
        ) : owned.isError ||
          (owned.data?.items.length === 0 &&
            owned.data.failedChains.length === chains.length) ? (
          <p className="mt-2 text-sm text-smoke-700">
            Couldn&apos;t load your items right now.
          </p>
        ) : owned.data && owned.data.items.length > 0 ? (
          <>
            <p className="mt-2 text-sm font-medium text-ink">
              {owned.data.totalCount || owned.data.items.length}{' '}
              {(owned.data.totalCount || owned.data.items.length) === 1
                ? 'item'
                : 'items'}{' '}
              owned
              {owned.data.capped
                ? ` (showing latest ${owned.data.items.length})`
                : ''}
            </p>
            <div className="mt-3 divide-y divide-smoke-100">
              {tallyItems(owned.data.items, names).map(item => (
                <div
                  key={item.tierId}
                  className="flex items-baseline justify-between gap-3 py-2 text-sm"
                >
                  <span className="font-medium text-ink">{item.label}</span>
                  <span className="text-smoke-700">×{item.count}</span>
                </div>
              ))}
            </div>
            {redeemable.data?.length ? (
              <button
                type="button"
                onClick={() => setRedeemTargets(redeemable.data)}
                className="mt-4 text-sm font-medium text-bluebs-600 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-700"
              >
                Redeem items for surplus →
              </button>
            ) : null}
            <PartialShopNotice failedChains={owned.data.failedChains} />
          </>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-smoke-700">
              You don&apos;t own any items from this shop yet.
            </p>
            {/* "You own nothing" is the wrong statement to make to someone
                whose only holdings are on the chain that failed. */}
            <PartialShopNotice
              failedChains={owned.data?.failedChains ?? []}
            />
          </>
        )}
      </div>

      <CustomerAllCard
        query={purchases}
        names={names}
        chainCount={chains.length}
        fallbackChainId={chainId}
      />

      {redeemTargets ? (
        <RedeemShopItemsModal
          targets={redeemTargets}
          names={names}
          onClose={() => setRedeemTargets(null)}
        />
      ) : null}
    </div>
  )
}

function CustomerAllCard({
  query,
  names,
  chainCount,
  fallbackChainId,
}: {
  query: UseQueryResult<BsShopRows<BsShopPurchase>, Error>
  names: Record<number, string>
  chainCount: number
  fallbackChainId: JBChainId
}) {
  const [visibleCustomers, setVisibleCustomers] = useState(100)
  if (query.isLoading) {
    return <CustomerCardSkeleton rows={6} />
  }
  if (
    query.isError ||
    (query.data?.items.length === 0 &&
      query.data.failedChains.length === chainCount)
  ) {
    return (
      <div className="card p-5">
        <span className="field-label">All</span>
        <p className="mt-2 text-sm text-smoke-700">
          Couldn&apos;t load customers right now.
        </p>
      </div>
    )
  }
  const data = query.data
  if (!data || data.items.length === 0) {
    return (
      <div className="card p-5">
        <span className="field-label">All</span>
        <p className="mt-2 text-sm text-smoke-700">
          No items have been bought yet.
        </p>
        {/* An absolute "nothing was bought" claim can't be made while some
            chain's purchases are unknown. */}
        <PartialShopNotice failedChains={data?.failedChains ?? []} />
      </div>
    )
  }

  const byCustomer = new Map<string, BsShopPurchase[]>()
  for (const purchase of data.items) {
    const key = purchase.beneficiary.toLowerCase()
    let got = byCustomer.get(key)
    if (!got) byCustomer.set(key, (got = []))
    got.push(purchase)
  }
  const customers = [...byCustomer.entries()].sort(
    (a, b) => b[1].length - a[1].length,
  )
  const total = data.totalCount || data.items.length

  return (
    <div className="card p-5">
      <span className="field-label">All</span>
      <p className="mt-2 text-sm font-medium text-ink">
        {customers.length.toLocaleString('en-US')}{' '}
        {customers.length === 1 ? 'customer' : 'customers'} |{' '}
        {total.toLocaleString('en-US')} {total === 1 ? 'item' : 'items'} sold
        {data.capped ? ` (showing latest ${data.items.length})` : ''}
      </p>

      <div className="mt-3 divide-y divide-smoke-100">
        {customers.slice(0, visibleCustomers).map(([customer, purchases]) => (
          <div
            key={customer}
            className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
          >
            <ExplorerAddress
              address={purchases[0].beneficiary}
              chainId={purchases[0].chainId || fallbackChainId}
            />
            <span className="text-xs text-smoke-700 sm:text-right">
              {tallyItems(purchases, names)
                .map(item =>
                  item.count > 1
                    ? `${item.count}× ${item.label}`
                    : item.label,
                )
                .join(', ')}
            </span>
          </div>
        ))}
      </div>
      {visibleCustomers < customers.length ? (
        <button
          type="button"
          className="btn-secondary mt-3 w-full"
          onClick={() => setVisibleCustomers(count => count + 100)}
        >
          Load more customers ({customers.length - visibleCustomers} remaining)
        </button>
      ) : null}

      <h3 className="mt-5 font-agrandir text-sm font-medium text-ink">
        Recent purchases
      </h3>
      <div className="mt-2 divide-y divide-smoke-100">
        {data.items.slice(0, 25).map(purchase => (
          <div
            key={`${purchase.chainId}:${purchase.txHash}:${purchase.tokenId}`}
            className="flex items-baseline justify-between gap-3 py-2 text-xs"
          >
            <ExplorerTransaction
              chainId={purchase.chainId || fallbackChainId}
              txHash={purchase.txHash}
              timestamp={purchase.timestamp}
            />
            <span className="min-w-0 truncate text-right text-smoke-700">
              {itemLabel(names, purchase.tierId)} →{' '}
              <AddressLabel address={purchase.beneficiary} />
            </span>
          </div>
        ))}
      </div>
      <PartialShopNotice failedChains={data.failedChains} />
    </div>
  )
}

function PartialShopNotice({ failedChains }: { failedChains: number[] }) {
  if (!failedChains.length) return null
  return (
    <p className="mt-3 text-xs leading-relaxed text-peel-600">
      Couldn&apos;t load {failedChains.map(chainName).join(', ')} — what&apos;s shown
      here leaves that chain out.
    </p>
  )
}

function ExplorerAddress({
  address,
  chainId,
}: {
  address: string
  chainId: number
}) {
  return (
    <AddressLink
      address={address}
      chainId={chainId}
      className="shrink-0 font-medium text-ink"
    />
  )
}

function ExplorerTransaction({
  chainId,
  txHash,
  timestamp,
}: {
  chainId: number
  txHash: string
  timestamp: number
}) {
  const txUrl = explorerTxUrl(chainId, txHash)
  const label = timeAgo(timestamp)
  return txUrl ? (
    <a
      href={txUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 font-medium text-bluebs-600 hover:underline"
    >
      {label === 'now' ? 'now' : `${label} ago`}
    </a>
  ) : (
    <span className="shrink-0 text-smoke-500">
      {label === 'now' ? 'now' : `${label} ago`}
    </span>
  )
}

function itemLabel(names: Record<number, string>, tierId: number): string {
  return names[tierId] ?? `Item #${tierId}`
}

function tallyItems<T extends { tierId: number }>(
  rows: T[],
  names: Record<number, string>,
): { tierId: number; count: number; label: string }[] {
  const counts = new Map<number, number>()
  for (const row of rows) {
    counts.set(row.tierId, (counts.get(row.tierId) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([tierId, count]) => ({
      tierId,
      count,
      label: itemLabel(names, tierId),
    }))
    .sort((a, b) => b.count - a.count || a.tierId - b.tierId)
}

function ShopEditorLoading({ onClose }: { onClose: () => void }) {
  return (
    <ModalShell title="Add items for sale" onClose={onClose} maxWidth="max-w-lg">
      <FormFieldsSkeleton rows={4} label="Loading shop item editor" />
    </ModalShell>
  )
}

type StoreMediaKind = 'image' | 'video' | 'audio' | 'document' | 'unknown'

function storeMediaKind(mediaType: string | undefined, url: string): StoreMediaKind {
  const mime = mediaType?.toLowerCase() ?? ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || mime.startsWith('text/')) return 'document'

  const path = (url.split(/[?#]/, 1)[0] ?? '').toLowerCase()
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(path)) return 'image'
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(path)) return 'video'
  if (/\.(mp3|wav|ogg|m4a|aac|flac)$/.test(path)) return 'audio'
  if (/\.(pdf|txt|md)$/.test(path)) return 'document'
  return 'unknown'
}

function resolvedStoreMedia(media: TierMedia | undefined) {
  if (!media) return null
  const source = media.animationUrl || media.image || ''
  if (!source) return null
  const kind = storeMediaKind(media.mediaType, source)
  return {
    source,
    poster: media.animationUrl && media.image ? media.image : undefined,
    // An extension-less gateway URL from the image field IS an image
    // (website parity) — never a "Media file" placeholder.
    kind: kind === 'unknown' && !media.animationUrl ? 'image' : kind,
  }
}

function LazyStoreVideo({
  src,
  poster,
  alt,
  detail,
  onError,
}: {
  src: string
  poster?: string
  alt: string
  detail: boolean
  onError: () => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const [nearViewport, setNearViewport] = useState(detail)
  const [visible, setVisible] = useState(detail)

  useEffect(() => {
    if (detail) return
    const node = ref.current
    if (!node || !('IntersectionObserver' in window)) {
      setNearViewport(true)
      return
    }
    const loader = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) setNearViewport(true)
      },
      { rootMargin: '240px 0px' },
    )
    const player = new IntersectionObserver(
      entries => setVisible(entries.some(entry => entry.intersectionRatio >= 0.35)),
      { threshold: [0, 0.35] },
    )
    loader.observe(node)
    player.observe(node)
    return () => {
      loader.disconnect()
      player.disconnect()
    }
  }, [detail])

  useEffect(() => {
    if (detail) return
    const node = ref.current
    if (!node) return
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    if (visible && nearViewport && !reducedMotion) {
      void node.play().catch(() => undefined)
    } else {
      node.pause()
    }
  }, [detail, nearViewport, visible])

  return (
    <video
      ref={ref}
      src={detail || nearViewport ? src : undefined}
      poster={poster}
      aria-label={alt}
      controls={detail}
      muted={!detail}
      loop={!detail}
      playsInline
      preload={detail ? 'metadata' : 'none'}
      onError={onError}
      className={
        detail
          ? 'max-h-[28rem] w-full rounded-lg object-contain'
          : 'h-full w-full object-contain'
      }
    />
  )
}

function StoreMediaPreview({
  media,
  alt,
  detail = false,
}: {
  media: TierMedia | undefined
  alt: string
  detail?: boolean
}) {
  const resolved = resolvedStoreMedia(media)
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [resolved?.source])

  if (!resolved || failed) {
    return (
      media ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-smoke-500">
          No media
        </div>
      ) : (
        <Skeleton className="h-full min-h-32 w-full" role="status" aria-label="Loading item media" />
      )
    )
  }

  if (resolved.kind === 'image') {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolved.source}
        alt={alt}
        loading={detail ? 'eager' : 'lazy'}
        decoding="async"
        onError={() => setFailed(true)}
        className={
          detail
            ? 'max-h-[28rem] w-full rounded-lg object-contain'
            : 'h-full w-full object-contain'
        }
      />
    )
  }

  if (resolved.kind === 'video') {
    return (
      <LazyStoreVideo
        src={resolved.source}
        poster={resolved.poster}
        alt={alt}
        detail={detail}
        onError={() => setFailed(true)}
      />
    )
  }

  if (resolved.kind === 'audio' && detail) {
    return (
      <audio
        src={resolved.source}
        controls
        preload="none"
        aria-label={alt}
        className="w-full"
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-sm text-smoke-600">
      <span aria-hidden="true" className="text-3xl">
        {resolved.kind === 'audio' ? '♪' : '↗'}
      </span>
      {detail ? (
        <a
          href={resolved.source}
          target="_blank"
          rel="noreferrer"
          className="text-bluebs-700 underline underline-offset-4"
        >
          Open media
        </a>
      ) : (
        <span>{resolved.kind === 'audio' ? 'Audio' : 'Media file'}</span>
      )}
    </div>
  )
}

/**
 * The cart-facing view of a tier both the card and the detail modal derive:
 * supply/discount state, the registered cart item, and its live quantity.
 */
function useTierCartItem(tier: ShopTier, media: TierMedia | undefined) {
  const { quantityOf, setQuantity, registerItem } = useShopCart()
  const quantity = quantityOf(tier.id)
  const unlimited = tier.initial >= TIER_UNLIMITED_SUPPLY
  const soldOut = !unlimited && tier.remaining <= 0
  const cap = unlimited ? 99 : tier.remaining
  const discounted = tier.discountPercent > 0
  const effective = effectiveTierPrice(tier.price, tier.discountPercent)
  const item = useMemo(
    () => ({
      tierId: tier.id,
      name: media?.name ?? `Item #${tier.id}`,
      image: media?.image,
    }),
    [tier.id, media?.name, media?.image],
  )

  useEffect(() => registerItem(item), [item, registerItem])

  return {
    quantity,
    setQuantity,
    unlimited,
    soldOut,
    cap,
    discounted,
    effective,
    item,
  }
}

function TierCard({
  tier,
  media,
  pricing,
  transfersPaused,
  onOpen,
}: {
  tier: ShopTier
  media: TierMedia | undefined
  pricing: Shop['pricing']
  transfersPaused: boolean | null
  onOpen: () => void
}) {
  const {
    quantity,
    setQuantity,
    unlimited,
    soldOut,
    cap,
    discounted,
    effective,
    item,
  } = useTierCartItem(tier, media)

  return (
    <div
      data-tier-id={tier.id}
      className={`card flex h-full flex-col overflow-hidden transition ${
        quantity > 0 ? '!border-bluebs-500' : ''
      } ${soldOut ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="relative block aspect-square w-full bg-white text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bluebs-500"
        aria-label={`View details for ${item.name}`}
      >
        <StoreMediaPreview media={media} alt={item.name} />
        {discounted ? (
          <span className="absolute left-2 top-2 rounded-full bg-ink px-2 py-0.5 text-[11px] font-medium text-bone">
            {discountLabel(tier.discountPercent)}
          </span>
        ) : null}
        {soldOut ? (
          <span className="absolute right-2 top-2 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-medium text-ink">
            Sold out
          </span>
        ) : null}
        {transfersPaused ? (
          <span className="absolute bottom-2 left-2 rounded-full bg-peel-100 px-2 py-0.5 text-[11px] font-medium text-peel-700">
            Transfers paused
          </span>
        ) : null}
        {quantity > 0 ? (
          <span className="absolute bottom-2 right-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-bluebs-600 px-2 text-xs font-medium text-white shadow-sm">
            {quantity}
          </span>
        ) : null}
      </button>

      <div className="flex-1 bg-split-25 p-3.5">
        <button
          type="button"
          onClick={onOpen}
          className="block w-full truncate text-left text-sm font-medium text-ink hover:underline"
        >
          {media?.name ?? `Item #${tier.id}`}
        </button>

        {media?.description ? (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-smoke-600">
            {plainText(media.description)}
          </p>
        ) : null}

        <p className="mt-1 text-sm text-ink">
          <span className="font-medium">
            {formatTokenAmount(effective, pricing.decimals)} {pricing.symbol}
          </span>
          {discounted ? (
            <span className="ml-1.5 text-xs text-smoke-500 line-through">
              {formatTokenAmount(tier.price, pricing.decimals)}
            </span>
          ) : null}
        </p>

        <div className="mt-2 flex items-center justify-between gap-2">
          <p className="text-xs text-smoke-700">
            {soldOut
              ? 'None left'
              : unlimited
                ? 'Unlimited'
                : `${tier.remaining.toLocaleString('en-US')} left`}
          </p>
          <QuantityStepper
            quantity={quantity}
            itemName={item.name}
            onRemove={() => setQuantity(tier.id, quantity - 1, item)}
            onAdd={() => setQuantity(tier.id, Math.min(cap, quantity + 1), item)}
            disabledRemove={quantity <= 0}
            disabledAdd={soldOut || quantity >= cap}
          />
        </div>

        {tier.reserveFrequency > 0 ? (
          <p className="mt-1 text-[11px] text-smoke-500">
            1 of every {tier.reserveFrequency} reserved
          </p>
        ) : null}
      </div>
    </div>
  )
}

function TierDetailModal({
  isRevnet,
  chainId,
  chains,
  tier,
  media,
  pricing,
  transfersPaused,
  onMint,
  onReplaceMedia,
  onClose,
}: {
  isRevnet: boolean
  /** The chain the page (and this modal's stepper inventory) is on. */
  chainId: JBChainId
  chains: [number, number][]
  tier: ShopTier
  media: TierMedia | undefined
  pricing: Shop['pricing']
  transfersPaused: boolean | null
  onMint?: () => void
  onReplaceMedia?: () => void
  onClose: () => void
}) {
  const {
    quantity,
    setQuantity,
    unlimited,
    soldOut,
    cap,
    discounted,
    effective,
    item,
  } = useTierCartItem(tier, media)
  const setFlags = tier.flags
    ? flagDescriptions(isRevnet).filter(([flag]) => tier.flags![flag])
    : []

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const supply = useQuery({
    queryKey: ['shopTierSupply', chains, isRevnet, tier.id],
    meta: PERSIST,
    staleTime: 30_000,
    retry: 1,
    queryFn: async () =>
      Promise.all(
        chains.map(async ([targetChainId, targetProjectId]) => {
          const targetId = targetChainId as JBChainId
          const client = getPublicClient(wagmiConfig, {
            chainId: targetId,
          }) as PublicClient | undefined
          if (!client) {
            return { chainId: targetId, state: 'unavailable' as const }
          }
          try {
            const targetShop = await getProject721Shop(client, {
              chainId: targetId,
              projectId: BigInt(targetProjectId),
              isRevnet,
              tierLimit: 0,
            })
            const targetTier = targetShop
              ? (
                  await client.readContract({
                    address: targetShop.store,
                    abi: jb721TiersHookStoreAbi,
                    functionName: 'tiersOf',
                    args: [
                      targetShop.hook,
                      [],
                      false,
                      BigInt(tier.id),
                      1n,
                    ],
                  })
                )[0]
              : undefined
            const matchingTier =
              targetTier && Number(targetTier.id) === tier.id
                ? targetTier
                : undefined
            if (!matchingTier) {
              return { chainId: targetId, state: 'missing' as const }
            }
            return {
              chainId: targetId,
              state: 'ready' as const,
              remaining: matchingTier.remainingSupply,
              initial: matchingTier.initialSupply,
            }
          } catch {
            return { chainId: targetId, state: 'unavailable' as const }
          }
        }),
      ),
  })

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy="shop-item-detail-title"
      className="items-start justify-center px-3 py-8 sm:items-center"
    >
      <div className="card relative w-full max-w-2xl overflow-hidden shadow-[0_24px_72px_rgba(19,17,25,0.28)]">
        <ModalCloseButton
          onClick={onClose}
          aria-label="Close item details"
          className="absolute right-3 top-3 z-10 bg-white/90 text-smoke-700 shadow-sm hover:bg-white"
        />

        <div className="grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex min-h-64 items-center justify-center bg-white p-5">
            <StoreMediaPreview media={media} alt={item.name} detail />
          </div>

          <div className="bg-split-25 p-5 sm:p-6">
            <h2
              id="shop-item-detail-title"
              className="pr-10 font-agrandir text-2xl font-medium text-ink"
            >
              {item.name}
            </h2>
            {media?.description ? (
              <p className="mt-2 text-sm leading-relaxed text-smoke-700">
                {plainText(media.description)}
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="font-agrandir text-xl font-medium text-ink">
                {formatTokenAmount(effective, pricing.decimals)}{' '}
                {pricing.symbol}
              </span>
              {discounted ? (
                <>
                  <span className="text-sm text-smoke-500 line-through">
                    {formatTokenAmount(tier.price, pricing.decimals)}{' '}
                    {pricing.symbol}
                  </span>
                  <span className="rounded-full bg-ink px-2 py-0.5 text-[11px] font-medium text-bone">
                    {discountLabel(tier.discountPercent)}
                  </span>
                </>
              ) : null}
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setQuantity(tier.id, quantity - 1, item)}
                disabled={quantity <= 0}
                aria-label={`Remove one ${item.name}`}
                className="btn-secondary flex h-10 w-10 items-center justify-center !px-0 disabled:opacity-40"
              >
                −
              </button>
              <span className="min-w-8 text-center font-medium tabular-nums text-ink">
                {quantity}
              </span>
              <button
                type="button"
                onClick={() =>
                  setQuantity(tier.id, Math.min(cap, quantity + 1), item)
                }
                disabled={soldOut || quantity >= cap}
                aria-label={`Add one ${item.name}`}
                className="btn-primary flex h-10 min-w-10 items-center justify-center !px-3 disabled:opacity-40"
              >
                +
              </button>
              <span className="ml-1 text-xs text-smoke-500">
                {soldOut
                  ? 'Sold out'
                  : unlimited
                    ? 'Unlimited inventory'
                    : `${tier.remaining.toLocaleString('en-US')} left on ${chainName(chainId)}`}
              </span>
            </div>

            {onMint ? (
              <button
                type="button"
                onClick={onMint}
                className="mt-3 text-sm font-medium text-bluebs-600 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-700"
              >
                Mint to a beneficiary without payment →
              </button>
            ) : null}

            <div className="mt-6 border-t border-smoke-200 pt-4">
              <p className="field-label">Supply by chain</p>
              <div className="mt-2 space-y-2">
                {supply.isLoading ? (
                  <SkeletonTable rows={Math.max(chains.length, 2)} columns={2} />
                ) : (
                  supply.data?.map(row => (
                    <div
                      key={row.chainId}
                      className="flex items-center justify-between gap-3 text-xs"
                    >
                      <span className="inline-flex items-center gap-1.5 text-smoke-700">
                        <ChainIcon chainId={row.chainId} size={17} />
                        {chainName(row.chainId)}
                      </span>
                      <span className="tabular-nums text-ink">
                        {row.state === 'missing'
                          ? 'Not on this chain'
                          : row.state === 'unavailable'
                            ? 'Unavailable'
                            : row.initial >= TIER_UNLIMITED_SUPPLY
                              ? 'Unlimited'
                              : `${row.remaining.toLocaleString('en-US')} / ${row.initial.toLocaleString('en-US')} left`}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <dl className="mt-5 space-y-2 border-t border-smoke-200 pt-4 text-xs">
              <DetailFact label="Item ID" value={`#${tier.id}`} />
              {tier.flags?.transfersPausable ? (
                <DetailFact
                  label="Transfers"
                  value={
                    transfersPaused == null
                      ? 'Current ruleset unavailable'
                      : transfersPaused
                        ? 'Paused now'
                        : 'Allowed now; ruleset-pausable'
                  }
                />
              ) : null}
              <DetailFact
                label="Category"
                value={media?.categoryName ?? String(tier.category)}
              />
              {discounted ? (
                <DetailFact
                  label="Current discount"
                  value={discountLabel(tier.discountPercent)}
                />
              ) : null}
              {tier.reserveFrequency > 0 ? (
                <DetailFact
                  label="Reserve mint"
                  value={`1 per ${tier.reserveFrequency} sold`}
                />
              ) : null}
              {tier.votingUnits > 0n ? (
                <DetailFact
                  label="Voting units"
                  value={tier.votingUnits.toLocaleString('en-US')}
                />
              ) : null}
            </dl>

            {setFlags.length > 0 ? (
              <div className="mt-5 border-t border-smoke-200 pt-4">
                <p className="field-label">Flags</p>
                <div className="mt-2 space-y-2">
                  {setFlags.map(([flag, label, description]) => (
                    <div key={flag}>
                      <p className="text-xs font-medium text-ink">{label}</p>
                      <p className="text-xs text-smoke-500">{description}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {onReplaceMedia ? (
              <button
                type="button"
                onClick={onReplaceMedia}
                className="mt-5 text-xs font-medium text-smoke-600 underline decoration-smoke-300 underline-offset-4 hover:text-ink"
              >
                Replace media
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </ModalDialog>
  )
}

function DetailFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-smoke-500">{label}</dt>
      <dd className="text-right text-ink">{value}</dd>
    </div>
  )
}

/** Strip markup/entities from resolver descriptions. Client-only: it's only
 *  reached once tier media resolves in the browser, so DOMParser is safe. */
function plainText(value: string): string {
  return (
    new DOMParser().parseFromString(
      value.replace(/<br\s*\/?>/gi, '\n'),
      'text/html',
    ).body.textContent ?? ''
  ).trim()
}

/** Shopper-facing "X% off" — the stored value is out of the SDK's denominator. */
function discountLabel(discountPercent: number): string {
  const pct = (discountPercent * 100) / Number(DISCOUNT_DENOMINATOR)
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}% off`
}

async function resolveLegacyTierUris(
  client: PublicClient,
  store: Address,
  hook: Address,
  tiers: Awaited<ReturnType<typeof readTierPage>>,
) {
  const legacy = tiers.filter(
    tier => tier.encodedIpfsUri.toLowerCase() === ZERO_BYTES32,
  )
  const resolved = new Map<number, string>()
  for (let offset = 0; offset < legacy.length; offset += 10) {
    const batch = await Promise.all(
      legacy.slice(offset, offset + 10).map(async tier => {
        const row = (
          await client.readContract({
            address: store,
            abi: jb721TiersHookStoreAbi,
            functionName: 'tiersOf',
            args: [hook, [], true, BigInt(tier.id), 1n],
          })
        )[0]
        return [tier.id, row?.resolvedUri ?? ''] as const
      }),
    )
    for (const entry of batch) resolved.set(...entry)
  }
  return resolved
}

/**
 * Resolve the project's shop: hook, store, pricing context, and tiers.
 * Returns null when the project authoritatively has no 721 shop; throws on
 * RPC failure so the UI shows an error instead of a false "no store".
 */
async function readShop(
  client: PublicClient,
  chainId: JBChainId,
  projectId: number,
  isRevnet: boolean,
  nativeSymbol: string,
): Promise<Shop | null> {
  const [identity, current] = await Promise.all([
    getProject721Shop(client, {
      chainId,
      projectId: BigInt(projectId),
      isRevnet,
      tierLimit: 0,
    }),
    getCurrentRuleset(client, {
      chainId,
      projectId: BigInt(projectId),
    }).catch(() => null),
  ])
  if (!identity) return null
  const resolved = identity
  const rawTiers = await readAllActiveTiers(
    client,
    resolved.store,
    resolved.hook,
  )
  const resolvedUriById = await resolveLegacyTierUris(
    client,
    resolved.store,
    resolved.hook,
    rawTiers,
  )

  const idTarget = resolved.metadataIdTarget
  if (!idTarget || idTarget === zeroAddress) {
    throw new Error('The shop metadata target is invalid.')
  }

  const { currency, decimals } = resolved.pricing

  let cashOutEnabled = false
  if (!isRevnet && current) {
    const dataHook = current.metadata.dataHook
    const omni = jbContractAddress['6'][
      JBOmnichainDeployerContracts.JBOmnichainDeployer
    ]?.[chainId] as Address | undefined
    if (
      omni &&
      dataHook &&
      dataHook.toLowerCase() === omni.toLowerCase()
    ) {
      // The ruleset flag only says to consult the omnichain deployer. Its
      // per-ruleset 721 config authoritatively decides whether cash outs are
      // forwarded to this collection.
      const configured = await client
        .readContract({
          address: omni,
          abi: jbOmnichainDeployerAbi,
          functionName: 'tiered721HookOf',
          args: [BigInt(projectId), BigInt(current.ruleset.id)],
        })
        .catch(() => null)
      cashOutEnabled = !!(
        configured &&
        configured[0].toLowerCase() === resolved.hook.toLowerCase() &&
        configured[1]
      )
    } else {
      // A direct custom-project data hook uses the ruleset flag itself.
      cashOutEnabled = !!(
        dataHook &&
        dataHook.toLowerCase() === resolved.hook.toLowerCase() &&
        current.metadata.useDataHookForCashOut
      )
    }
  }

  let symbol: string
  if (currency === BASE_CURRENCY_ETH) {
    symbol = nativeSymbol
  } else if (currency === BASE_CURRENCY_USD) {
    symbol = 'USD'
  } else {
    // Token-keyed currency (uint32(uint160(token))): match the project's
    // accounting contexts to find the token, then read its symbol.
    symbol = `currency #${currency}`
    const contexts = await getAccountingContexts(client, {
      chainId,
      projectId: BigInt(projectId),
    }).catch(() => [])
    const match = contexts.find(ctx => ctx.currency === currency)
    if (match) {
      symbol = await tokenSymbol(client, match.token, { chainId })
    }
  }

  // Tier and collection-wide flags come from the store directly —
  // getProject721Shop's tier shape doesn't carry them. These are display-only,
  // so failed reads leave their corresponding detail sections unavailable.
  const configFlags = await client
    .readContract({
        address: resolved.store,
        abi: jb721TiersHookStoreAbi,
        functionName: 'flagsOf',
        args: [resolved.hook],
      })
      .then(flags => ({ ...flags }))
    .catch(() => null)

  const tiers: ShopTier[] = rawTiers.map(tier => ({
    id: tier.id,
    price: tier.price,
    remaining: tier.remainingSupply,
    initial: tier.initialSupply,
    category: tier.category,
    discountPercent: tier.discountPercent,
    reserveFrequency: tier.reserveFrequency,
    votingUnits: tier.votingUnits,
    encodedIpfsUri: tier.encodedIpfsUri,
    resolvedUri: resolvedUriById.get(tier.id) ?? '',
    flags: { ...tier.flags },
  }))

  return {
    hook: resolved.hook,
    idTarget,
    cashOutEnabled,
    transfersPaused: current
      ? decode721RulesetMetadata(Number(current.metadata.metadata ?? 0))
          .pauseTransfers
      : null,
    pricing: { currency, decimals, symbol },
    tiers,
    configFlags,
  }
}

/** Resolve a tier's display metadata: the resolver's data URI first, then
 *  the tier's IPFS JSON. Best-effort — {} on any failure. */
async function resolveTierMedia(tier: ShopTier): Promise<TierMedia> {
  const pick = (json: Record<string, unknown>): TierMedia => {
    const meta = pickTierMetadata(json)
    return {
      name: meta.name,
      description: meta.description,
      image: tierMediaImageUrl(meta.image),
      animationUrl: tierMediaAssetUrl(meta.animationUrl),
      mediaType: meta.mediaType,
      categoryName: meta.categoryName,
    }
  }

  const resolved = tier.resolvedUri
    ? parseTierMetadataJson(tier.resolvedUri)
    : null
  if (resolved && Object.keys(resolved).length > 0) return pick(resolved)

  const cid = bytes32ToCidV0(tier.encodedIpfsUri)
  const url = cid ? appIpfsUrl(`ipfs://${cid}`) : null
  if (!url) return {}
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8_000)
    const res = await fetch(url, { signal: controller.signal }).finally(() =>
      clearTimeout(timer),
    )
    if (!res.ok) return {}
    const json = (await res.json()) as unknown
    return json && typeof json === 'object'
      ? pick(json as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

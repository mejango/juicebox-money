'use client'

import {
  JB_CHAINS,
  JBOmnichainDeployerContracts,
  jb721TiersHookAbi,
  jbContractAddress,
  jbOmnichainDeployerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  effectiveTierPrice,
  getAccountingContexts,
  getCurrentRuleset,
  getProject721Shop,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import Image from 'next/image'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  erc20Abi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { getPublicClient } from 'wagmi/actions'
import { ChainIcon } from '@/components/ChainIcon'
import {
  AddShopItemsModal,
  type ShopWriteTarget,
} from '@/components/project/AddShopItemsModal'
import {
  RedeemShopItemsModal,
  type RedeemableShopTarget,
} from '@/components/project/RedeemShopItemsModal'
import { SubTabs } from '@/components/project/Tabs'
import { useShopCart } from '@/components/project/ShopCartProvider'
import { useWallet } from '@/hooks/useWallet'
import type {
  BsOwnedShopItem,
  BsShopPurchase,
  BsShopRows,
} from '@/lib/bendystraw'
import {
  formatTokenAmount,
  ipfsUrl,
  timeAgo,
  truncateAddress,
} from '@/lib/format'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'

/**
 * Shop tab (website/ parity: renderShopSection) — the project's 721 tiers,
 * plus the owner/operator flow for adding new items. A shared cart connects
 * this inventory to the Pay card's checkout.
 *
 * Hook/store/metadata/pricing/tier resolution comes from the shared SDK's
 * getProject721Shop helper, so Pay and Shop use the same revnet, custom, and
 * omnichain rules. RPC failures surface as errors, never as "no shop".
 */

/** Initial supply at/above this sentinel means unlimited inventory
 *  (website/ parity: TIER_UNLIMITED_SUPPLY in nft721-build.js). */
const TIER_UNLIMITED_SUPPLY = 999_999_999

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
}

type Shop = {
  hook: Address
  /** Shared implementation address used to key 721 hook metadata. */
  idTarget: Address
  cashOutEnabled: boolean
  pricing: { currency: number; decimals: number; symbol: string }
  tiers: ShopTier[]
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
  chains = [[chainId, projectId]],
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
  /** [chain id, project id] for every linked deployment. */
  chains?: [number, number][]
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { isConnected, address } = useWallet()
  const { quantities: cart, count: cartCount } = useShopCart()
  const chainMeta = JB_CHAINS[chainId]
  const etherscanHost = chainMeta?.etherscanHostname
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

  const [category, setCategory] = useState<number | null>(null)
  const [addItemsOpen, setAddItemsOpen] = useState(false)
  const [detailTierId, setDetailTierId] = useState<number | null>(null)

  const {
    data: shop,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['shop721', chainId, projectId, isRevnet],
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
  const { data: mediaById } = useQuery({
    queryKey: ['shop721Media', chainId, shop?.hook],
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

  // Resolve each linked collection only when the operator opens the editor.
  // Per-chain failures stay local so one flaky RPC does not hide the chains
  // that are ready to receive items.
  const {
    data: writeTargets,
    isLoading: writeTargetsLoading,
  } = useQuery({
    queryKey: ['shop721WriteTargets', chains, isRevnet],
    enabled: addItemsOpen && !!shop,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<ShopWriteTarget[]> =>
      Promise.all(
        chains.map(async ([targetChainId, targetProjectId]) => {
          const targetId = targetChainId as JBChainId
          try {
            if (targetId === chainId && targetProjectId === projectId) {
              return {
                chainId: targetId,
                projectId: targetProjectId,
                hook: shop!.hook,
                pricing: shop!.pricing,
              }
            }
            const client = getPublicClient(wagmiConfig, {
              chainId: targetId,
            }) as PublicClient | undefined
            if (!client) throw new Error('RPC unavailable')
            const targetChain = JB_CHAINS[targetId]
            const resolved = await readShop(
              client,
              targetId,
              targetProjectId,
              isRevnet,
              targetChain?.nativeTokenSymbol ?? 'ETH',
            )
            return {
              chainId: targetId,
              projectId: targetProjectId,
              hook: resolved?.hook ?? null,
              pricing: resolved?.pricing ?? null,
              error: resolved ? undefined : 'No store on this chain',
            }
          } catch {
            return {
              chainId: targetId,
              projectId: targetProjectId,
              hook: null,
              pricing: null,
              error: 'Could not read this store',
            }
          }
        }),
      ),
  })

  if (isLoading) {
    return (
      <div className="card p-5">
        <span className="field-label">Shop</span>
        <p className="mt-2 text-sm text-smoke-500">Loading…</p>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="card p-5">
        <span className="field-label">Shop</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          Couldn&apos;t load the store right now — try again in a moment.
        </p>
      </div>
    )
  }

  if (!shop) {
    return (
      <div className="card p-5">
        <div>
          <span className="field-label">Shop</span>
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            No store yet.
            {isRevnet
              ? ' The operator can add items for supporters to buy.'
            : ''}
          </p>
        </div>
      </div>
    )
  }

  const collectionName = collectionMeta?.[0]?.result
  const collectionSymbol = collectionMeta?.[1]?.result

  const addItemsButton = (
    <button
      type="button"
      onClick={() => setAddItemsOpen(true)}
      className="text-sm font-medium text-bluebs-600 underline decoration-bluebs-300 underline-offset-4 hover:text-bluebs-700"
    >
      + Add items
    </button>
  )

  const inventory = (
    <div className="space-y-5">
      {shop.tiers.length > 0 ? (
        <div className="flex justify-end">{addItemsButton}</div>
      ) : null}

      {isConnected && (credits ?? 0n) > 0n ? (
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
              No items in the store yet.
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
              {collectionName ?? '—'}
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
              {etherscanHost ? (
                <a
                  href={`https://${etherscanHost}/address/${shop.hook}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ink hover:underline"
                >
                  {truncateAddress(shop.hook)}
                </a>
              ) : (
                <span className="text-ink">{truncateAddress(shop.hook)}</span>
              )}
            </dd>
          </div>
        </dl>
      </div>

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
          chains={chains}
          tier={detailTier}
          media={mediaById?.[detailTier.id]}
          pricing={shop.pricing}
          onClose={() => setDetailTierId(null)}
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

type LinkedShop = {
  chainId: JBChainId
  projectId: number
  shop: Shop
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
  const { isConnected, address, openSignIn } = useWallet()
  const [mounted, setMounted] = useState(false)
  const [redeemTargets, setRedeemTargets] = useState<
    RedeemableShopTarget[] | null
  >(null)
  useEffect(() => setMounted(true), [])
  const connected = mounted && isConnected && !!address

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
    queryFn: async (): Promise<LinkedShop[]> => {
      const resolved = await Promise.all(
        chains.map(async ([targetChainId, targetProjectId]) => {
          const targetId = targetChainId as JBChainId
          if (targetId === chainId && targetProjectId === projectId) {
            return { chainId: targetId, projectId: targetProjectId, shop: primaryShop }
          }
          try {
            const client = getPublicClient(wagmiConfig, {
              chainId: targetId,
            }) as PublicClient | undefined
            if (!client) return null
            const targetChain = JB_CHAINS[targetId]
            const shop = await readShop(
              client,
              targetId,
              targetProjectId,
              isRevnet,
              targetChain?.nativeTokenSymbol ?? 'ETH',
            )
            return shop
              ? { chainId: targetId, projectId: targetProjectId, shop }
              : null
          } catch {
            return null
          }
        }),
      )
      return resolved.filter((value): value is LinkedShop => value !== null)
    },
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
          <p className="mt-2 text-sm text-smoke-500">Loading your items…</p>
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
          <p className="mt-2 text-sm leading-relaxed text-smoke-700">
            You don&apos;t own any items from this shop yet.
          </p>
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
  if (query.isLoading) {
    return (
      <div className="card p-5">
        <span className="field-label">All</span>
        <p className="mt-2 text-sm text-smoke-500">Loading customers…</p>
      </div>
    )
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
      </div>
    )
  }

  const byCustomer = new Map<string, BsShopPurchase[]>()
  for (const purchase of data.items) {
    const key = purchase.beneficiary.toLowerCase()
    byCustomer.set(key, [...(byCustomer.get(key) ?? []), purchase])
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
        {customers.length === 1 ? 'customer' : 'customers'} ·{' '}
        {total.toLocaleString('en-US')} {total === 1 ? 'item' : 'items'} sold
        {data.capped ? ` (showing latest ${data.items.length})` : ''}
      </p>

      <div className="mt-3 divide-y divide-smoke-100">
        {customers.slice(0, 100).map(([customer, purchases]) => (
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
              {truncateAddress(purchase.beneficiary)}
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
      Couldn&apos;t load {failedChains.map(chainName).join(', ')}; totals above are
      partial.
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
  const host = JB_CHAINS[chainId as JBChainId]?.etherscanHostname
  return host ? (
    <a
      href={`https://${host}/address/${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="shrink-0 font-medium text-ink hover:underline"
    >
      {truncateAddress(address)}
    </a>
  ) : (
    <span className="shrink-0 font-medium text-ink">
      {truncateAddress(address)}
    </span>
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
  const host = JB_CHAINS[chainId as JBChainId]?.etherscanHostname
  const label = timeAgo(timestamp)
  return host ? (
    <a
      href={`https://${host}/tx/${txHash}`}
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
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-slate-950/55 px-3 py-10"
      role="dialog"
      aria-modal="true"
      aria-labelledby="loading-shop-editor-title"
    >
      <div className="card w-full max-w-lg p-6 shadow-[0_24px_72px_rgba(19,17,25,0.28)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="loading-shop-editor-title"
              className="font-agrandir text-xl font-medium text-ink"
            >
              Add items for sale
            </h2>
            <p className="mt-2 text-sm text-smoke-700">
              Reading the collection on each chain…
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 items-center justify-center rounded-lg text-xl text-smoke-700 hover:bg-smoke-75"
          >
            ×
          </button>
        </div>
      </div>
    </div>
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
  return {
    source,
    poster: media.animationUrl && media.image ? media.image : undefined,
    kind: storeMediaKind(media.mediaType, source),
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
          : 'h-full w-full object-cover'
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
      <div className="flex h-full w-full items-center justify-center text-xs text-smoke-500">
        {media ? 'No media' : 'Loading…'}
      </div>
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
            : 'h-full w-full object-cover'
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

function TierCard({
  tier,
  media,
  pricing,
  onOpen,
}: {
  tier: ShopTier
  media: TierMedia | undefined
  pricing: Shop['pricing']
  onOpen: () => void
}) {
  const unlimited = tier.initial >= TIER_UNLIMITED_SUPPLY
  const soldOut = !unlimited && tier.remaining <= 0
  const discounted = tier.discountPercent > 0
  const effective = effectiveTierPrice(tier.price, tier.discountPercent)
  const { quantityOf, setQuantity, registerItem } = useShopCart()
  const quantity = quantityOf(tier.id)
  const cap = unlimited ? 99 : tier.remaining
  const item = useMemo(
    () => ({
      tierId: tier.id,
      name: media?.name ?? `Item #${tier.id}`,
      image: media?.image,
    }),
    [tier.id, media?.name, media?.image],
  )

  useEffect(() => registerItem(item), [item, registerItem])

  return (
    <div
      data-tier-id={tier.id}
      className={`card overflow-hidden transition ${
        quantity > 0 ? '!border-bluebs-500' : ''
      } ${soldOut ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="relative block aspect-square w-full bg-smoke-100 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bluebs-500"
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
        {quantity > 0 ? (
          <span className="absolute bottom-2 right-2 flex h-7 min-w-7 items-center justify-center rounded-full bg-bluebs-600 px-2 text-xs font-medium text-white shadow-sm">
            {quantity}
          </span>
        ) : null}
      </button>

      <div className="p-3.5">
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
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setQuantity(tier.id, quantity - 1, item)}
              disabled={quantity <= 0}
              aria-label={`Remove one ${item.name}`}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-smoke-300 text-sm text-smoke-700 disabled:opacity-35"
            >
              −
            </button>
            <span className="min-w-4 text-center text-xs tabular-nums text-ink">
              {quantity}
            </span>
            <button
              type="button"
              onClick={() =>
                setQuantity(tier.id, Math.min(cap, quantity + 1), item)
              }
              disabled={soldOut || quantity >= cap}
              aria-label={`Add one ${item.name}`}
              className="flex h-7 w-7 items-center justify-center rounded-full border border-smoke-300 text-sm text-smoke-700 disabled:opacity-35"
            >
              +
            </button>
          </div>
        </div>

        {tier.reserveFrequency > 0 || tier.votingUnits > 0n ? (
          <p className="mt-1 text-[11px] text-smoke-500">
            {[
              tier.reserveFrequency > 0
                ? `1 of every ${tier.reserveFrequency} reserved`
                : null,
              tier.votingUnits > 0n
                ? `${tier.votingUnits.toLocaleString('en-US')} votes each`
                : null,
            ]
              .filter(Boolean)
              .join(', ')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function TierDetailModal({
  isRevnet,
  chains,
  tier,
  media,
  pricing,
  onClose,
}: {
  isRevnet: boolean
  chains: [number, number][]
  tier: ShopTier
  media: TierMedia | undefined
  pricing: Shop['pricing']
  onClose: () => void
}) {
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

  useEffect(() => {
    registerItem(item)
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
  }, [item, registerItem, onClose])

  const supply = useQuery({
    queryKey: ['shopTierSupply', chains, isRevnet, tier.id],
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
              tierLimit: 200,
            })
            const targetTier = targetShop?.tiers.find(
              candidate => candidate.id === tier.id,
            )
            if (!targetTier) {
              return { chainId: targetId, state: 'missing' as const }
            }
            return {
              chainId: targetId,
              state: 'ready' as const,
              remaining: targetTier.remainingSupply,
              initial: targetTier.initialSupply,
            }
          } catch {
            return { chainId: targetId, state: 'unavailable' as const }
          }
        }),
      ),
  })

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center overflow-y-auto bg-slate-950/55 px-3 py-8 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shop-item-detail-title"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="card relative w-full max-w-2xl overflow-hidden shadow-[0_24px_72px_rgba(19,17,25,0.28)]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close item details"
          className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-xl text-smoke-700 shadow-sm hover:bg-white"
        >
          ×
        </button>

        <div className="grid md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex min-h-64 items-center justify-center bg-smoke-100 p-5">
            <StoreMediaPreview media={media} alt={item.name} detail />
          </div>

          <div className="p-5 sm:p-6">
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
                    : `${tier.remaining.toLocaleString('en-US')} left here`}
              </span>
            </div>

            <div className="mt-6 border-t border-smoke-200 pt-4">
              <p className="field-label">Supply by chain</p>
              <div className="mt-2 space-y-2">
                {supply.isLoading ? (
                  <p className="text-xs text-smoke-500">Reading supply…</p>
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
              <DetailFact label="Category" value={String(tier.category)} />
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
          </div>
        </div>
      </div>
    </div>
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

function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim()
}

/** Shopper-facing "X% off" — discountPercent is out of 200. */
function discountLabel(discountPercent: number): string {
  const pct = discountPercent / 2
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}% off`
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
  const [resolved, current] = await Promise.all([
    getProject721Shop(client, {
      chainId,
      projectId: BigInt(projectId),
      isRevnet,
      tierLimit: 200,
    }),
    getCurrentRuleset(client, {
      chainId,
      projectId: BigInt(projectId),
    }).catch(() => null),
  ])
  if (!resolved) return null

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
      symbol = await client
        .readContract({
          address: match.token,
          abi: erc20Abi,
          functionName: 'symbol',
        })
        .catch(() => truncateAddress(match.token))
    }
  }

  const tiers: ShopTier[] = resolved.tiers.map(tier => ({
    id: tier.id,
    price: tier.price,
    remaining: tier.remainingSupply,
    initial: tier.initialSupply,
    category: tier.category,
    discountPercent: tier.discountPercent,
    reserveFrequency: tier.reserveFrequency,
    votingUnits: tier.votingUnits,
    encodedIpfsUri: tier.encodedIpfsUri,
    resolvedUri: tier.resolvedUri ?? '',
  }))

  return {
    hook: resolved.hook,
    idTarget,
    cashOutEnabled,
    pricing: { currency, decimals, symbol },
    tiers,
  }
}

/** Parse a data:application/json;base64 URI into its JSON object. */
function parseDataJson(uri: string): Record<string, unknown> | null {
  const match = /^data:application\/json;base64,(.*)$/.exec(uri)
  if (!match) return null
  try {
    // decodeURIComponent(escape(...)) round-trips UTF-8 through atob.
    const json = JSON.parse(decodeURIComponent(escape(atob(match[1]))))
    return json && typeof json === 'object' ? json : null
  } catch {
    return null
  }
}

/**
 * Make a metadata image renderable in an <img>. Resolvers sometimes return
 * an SVG data URI that merely wraps an external <image href="…"> (website/
 * parity) — browsers block external loads inside an <img> data URI, so pull
 * the href out and load the bitmap directly. Self-contained SVGs pass
 * through, and ipfs:// URLs go through the gateway.
 */
function mediaImageUrl(image: unknown): string {
  if (typeof image !== 'string' || !image) return ''
  const svg = /^data:image\/svg\+xml;base64,(.*)$/.exec(image)
  if (svg) {
    try {
      const inner = /<image[^>]+href="([^"]+)"/.exec(
        decodeURIComponent(escape(atob(svg[1]))),
      )
      if (inner) return gatewayUrl(inner[1])
    } catch {
      // Fall through to the data URI itself.
    }
    return image
  }
  return gatewayUrl(image)
}

function gatewayUrl(url: string): string {
  return url.startsWith('ipfs://') ? (ipfsUrl(url) ?? '') : url
}

function mediaAssetUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return gatewayUrl(value) || undefined
}

/** Resolve a tier's display metadata: the resolver's data URI first, then
 *  the tier's IPFS JSON. Best-effort — {} on any failure. */
async function resolveTierMedia(tier: ShopTier): Promise<TierMedia> {
  const pick = (json: Record<string, unknown>): TierMedia => ({
    name: str(json.productName) ?? str(json.name),
    description: str(json.productDescription) ?? str(json.description),
    image: mediaImageUrl(json.image ?? json.imageUri),
    animationUrl: mediaAssetUrl(json.animation_url ?? json.animationUrl),
    mediaType:
      str(json.mediaType) ?? str(json.animationType) ?? str(json.mimeType),
    categoryName: str(json.categoryName),
  })

  const resolved = tier.resolvedUri ? parseDataJson(tier.resolvedUri) : null
  if (resolved && Object.keys(resolved).length > 0) return pick(resolved)

  const cid = bytes32ToCidV0(tier.encodedIpfsUri)
  const url = cid ? ipfsUrl(cid) : null
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

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

// ---- bytes32 → CIDv0 (the reverse of src/lib/ipfs-cid.ts) ----
// The 721 hook stores only the sha2-256 digest onchain; the CIDv0 is
// multihash 0x12 0x20 + digest, base58-encoded.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Encode(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256
      digits[i] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  for (const byte of bytes) {
    if (byte !== 0) break
    digits.push(0)
  }
  return digits
    .reverse()
    .map(digit => B58[digit])
    .join('')
}

function bytes32ToCidV0(hex: `0x${string}`): string | null {
  const clean = hex.slice(2)
  if (!/^[0-9a-fA-F]{64}$/.test(clean) || /^0+$/.test(clean)) return null
  const bytes = new Uint8Array(34)
  bytes[0] = 0x12 // sha2-256
  bytes[1] = 0x20 // 32 bytes
  for (let i = 0; i < 32; i++) {
    bytes[i + 2] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return base58Encode(bytes)
}

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
  getAccountingContexts,
  getCurrentRuleset,
  getRevnetTiered721Hook,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  erc20Abi,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount, ipfsUrl, truncateAddress } from '@/lib/format'

/**
 * Shop tab (website/ parity: renderShopSection) — a READ-ONLY storefront of
 * the project's 721 tiers. Buying happens in the Pay card, not here.
 *
 * Hook resolution mirrors website/'s readShopHook: revnets read
 * REVOwner.tiered721HookOf (via the SDK); custom projects read the current
 * ruleset's dataHook — either the omnichain deployer (real hook lives in
 * JBOmnichainDeployer.tiered721HookOf(projectId, rulesetId)) or the 721 hook
 * itself, verified by probing STORE() (revert = not a 721 hook = no shop).
 * RPC failures surface as errors, never as "no shop".
 */

/** Initial supply at/above this sentinel means unlimited inventory
 *  (website/ parity: TIER_UNLIMITED_SUPPLY in nft721-build.js). */
const TIER_UNLIMITED_SUPPLY = 999_999_999

/** JB721TiersHookStore's DISCOUNT_DENOMINATOR: discountPercent is out of
 *  200, so the shopper-facing "% off" is discountPercent / 2. */
const DISCOUNT_DENOMINATOR = 200n

type ShopTier = {
  id: number
  /** Full (undiscounted) price in the shop's pricing terms. */
  price: bigint
  remaining: number
  initial: number
  category: number
  /** Out of 200 — see DISCOUNT_DENOMINATOR. */
  discountPercent: number
  reserveFrequency: number
  votingUnits: bigint
  encodedIpfsUri: `0x${string}`
  /** tokenUriResolver output (tiersOf includeResolvedUri=true); '' if none. */
  resolvedUri: string
}

type Shop = {
  hook: Address
  store: Address
  pricing: { currency: number; decimals: number; symbol: string }
  tiers: ShopTier[]
}

type TierMedia = {
  name?: string
  description?: string
  image?: string
  categoryName?: string
}

export function ShopTab({
  chainId,
  projectId,
  isRevnet,
}: {
  chainId: JBChainId
  projectId: number
  isRevnet: boolean
}) {
  const publicClient = usePublicClient({ chainId }) as PublicClient | undefined
  const { isConnected, address } = useWallet()
  const chainMeta = JB_CHAINS[chainId]
  const etherscanHost = chainMeta?.etherscanHostname
  const nativeSymbol = chainMeta?.nativeTokenSymbol ?? 'ETH'

  const [category, setCategory] = useState<number | null>(null)

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
        <span className="field-label">Shop</span>
        <p className="mt-2 text-sm leading-relaxed text-smoke-700">
          No store yet.
          {isRevnet
            ? ' The operator can add items for supporters to buy.'
            : ''}
        </p>
      </div>
    )
  }

  const collectionName = collectionMeta?.[0]?.result
  const collectionSymbol = collectionMeta?.[1]?.result

  return (
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-smoke-700">
        Buy from the Pay box — every purchase supports the project.
      </p>

      {isConnected && (credits ?? 0n) > 0n ? (
        <p className="rounded-lg bg-split-50 px-3.5 py-2.5 text-sm text-smoke-900">
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
          <p className="text-sm leading-relaxed text-smoke-700">
            No items in the store yet.
            {isRevnet ? ' The operator can add some.' : ''}
          </p>
        </div>
      ) : (
        <>
          {categories.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {[{ id: null as number | null, name: 'All' }, ...categories].map(
                cat => (
                  <button
                    key={cat.id ?? 'all'}
                    onClick={() => setCategory(cat.id)}
                    aria-pressed={category === cat.id}
                    className={`min-h-[32px] rounded-full border px-3 text-xs font-medium transition-colors ${
                      category === cat.id
                        ? 'border-ink bg-ink text-bone'
                        : 'border-smoke-200 text-smoke-700 hover:text-ink'
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
    </div>
  )
}

function TierCard({
  tier,
  media,
  pricing,
}: {
  tier: ShopTier
  media: TierMedia | undefined
  pricing: Shop['pricing']
}) {
  const unlimited = tier.initial >= TIER_UNLIMITED_SUPPLY
  const soldOut = !unlimited && tier.remaining <= 0
  const discounted = tier.discountPercent > 0
  const effective = tierEffectivePrice(tier.price, tier.discountPercent)
  const [imageFailed, setImageFailed] = useState(false)

  return (
    <div
      className={`card overflow-hidden ${soldOut ? 'opacity-60' : ''}`}
    >
      <div className="relative aspect-square bg-smoke-100">
        {media?.image && !imageFailed ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={media.image}
            alt={media.name ?? `Item #${tier.id}`}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-smoke-500">
            {media ? 'No media' : 'Loading…'}
          </div>
        )}
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
      </div>

      <div className="p-3.5">
        <p className="truncate text-sm font-medium text-ink">
          {media?.name ?? `Item #${tier.id}`}
        </p>

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

        <p className="mt-1 text-xs text-smoke-700">
          {soldOut
            ? 'None left'
            : unlimited
              ? 'Unlimited'
              : `${tier.remaining.toLocaleString('en-US')} left`}
        </p>

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
              .join(' · ')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/** Effective (discounted) price, mirroring JB721TiersHookStore:
 *  price - mulDiv(price, discountPercent, 200) with integer-floor division. */
function tierEffectivePrice(price: bigint, discountPercent: number): bigint {
  let d = BigInt(discountPercent)
  if (d <= 0n) return price
  if (d > DISCOUNT_DENOMINATOR) d = DISCOUNT_DENOMINATOR
  return price - (price * d) / DISCOUNT_DENOMINATOR
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
  // 1. The 721 hook.
  let hook: Address | null = null
  // Non-authoritative = the ruleset dataHook might be some other hook; the
  // STORE() probe below decides.
  let authoritative = true

  if (isRevnet) {
    const revnetHook = await getRevnetTiered721Hook(client, {
      chainId,
      revnetId: BigInt(projectId),
    })
    hook = revnetHook && revnetHook !== zeroAddress ? revnetHook : null
  } else {
    const { ruleset, metadata } = await getCurrentRuleset(client, {
      chainId,
      projectId: BigInt(projectId),
    })
    const dataHook = metadata.dataHook
    if (metadata.useDataHookForPay && dataHook && dataHook !== zeroAddress) {
      const omni = jbContractAddress['6'][
        JBOmnichainDeployerContracts.JBOmnichainDeployer
      ]?.[chainId] as Address | undefined
      if (omni && dataHook.toLowerCase() === omni.toLowerCase()) {
        // Omnichain project: the real 721 hook lives in the deployer's
        // per-ruleset mapping.
        const [omniHook] = await client.readContract({
          address: omni,
          abi: jbOmnichainDeployerAbi,
          functionName: 'tiered721HookOf',
          args: [BigInt(projectId), BigInt(ruleset.id)],
        })
        hook = omniHook !== zeroAddress ? omniHook : null
      } else {
        // Single-chain custom project: the dataHook may be the 721 hook
        // itself.
        hook = dataHook
        authoritative = false
      }
    }
  }
  if (!hook) return null

  // 2. The hook's store. For a non-authoritative candidate a revert means
  // "not a 721 hook" (no shop); for an authoritative one, let failures throw.
  const store = authoritative
    ? await client.readContract({
        address: hook,
        abi: jb721TiersHookAbi,
        functionName: 'STORE',
      })
    : await client
        .readContract({
          address: hook,
          abi: jb721TiersHookAbi,
          functionName: 'STORE',
        })
        .catch(() => null)
  if (!store) return null

  // 3. Pricing context — tier prices are meaningless without the hook's
  // exact currency + decimals, so this read failing is an error, not a
  // fallback.
  const [currencyRaw, decimalsRaw] = await client.readContract({
    address: hook,
    abi: jb721TiersHookAbi,
    functionName: 'pricingContext',
  })
  const currency = Number(currencyRaw)
  const decimals = Number(decimalsRaw)

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

  // 4. The tiers, with resolver URIs included so cards can name themselves
  // without a per-tier resolver read.
  const raw = await client.readContract({
    address: store,
    abi: jb721TiersHookStoreAbi,
    functionName: 'tiersOf',
    args: [hook, [], true, 0n, 50n],
  })
  const tiers: ShopTier[] = raw
    .map(tier => ({
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
    .filter(tier => tier.initial > 0)

  return { hook, store, pricing: { currency, decimals, symbol }, tiers }
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

/** Resolve a tier's display metadata: the resolver's data URI first, then
 *  the tier's IPFS JSON. Best-effort — {} on any failure. */
async function resolveTierMedia(tier: ShopTier): Promise<TierMedia> {
  const pick = (json: Record<string, unknown>): TierMedia => ({
    name: str(json.productName) ?? str(json.name),
    description: str(json.productDescription) ?? str(json.description),
    image: mediaImageUrl(json.image ?? json.imageUri),
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

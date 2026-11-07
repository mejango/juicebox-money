import { jb721TiersHookStoreAbi } from '@bananapus/nana-sdk-core'
import type { Address, PublicClient } from 'viem'

/**
 * Reading a 721 shop's tiers COMPLETELY.
 *
 * `tiersOf`'s `size` is a hard cap, not a page hint, so a single call silently truncates a
 * large shop. Both the Shop tab and the Pay panel need the whole set — the Pay panel prunes
 * cart rows against it, and pruning against a truncated set deletes items the shopper added.
 */

const TIER_PAGE_SIZE = 200

/** One page of active tiers. `startingId` is inclusive, so every page after the first repeats
 *  its cursor row — hence the +1 size and the slice in readAllActiveTiers. */
export async function readTierPage(
  client: PublicClient,
  store: Address,
  hook: Address,
  startingId: bigint,
  includeResolvedUri = false,
  options: { size?: bigint; blockNumber?: bigint } = {},
) {
  return client.readContract({
    address: store,
    abi: jb721TiersHookStoreAbi,
    functionName: 'tiersOf',
    args: [
      hook,
      [],
      includeResolvedUri,
      startingId,
      options.size ?? BigInt(startingId === 0n ? TIER_PAGE_SIZE : TIER_PAGE_SIZE + 1),
    ],
    ...(options.blockNumber === undefined ? {} : { blockNumber: options.blockNumber }),
  })
}

export async function readAllActiveTiers(
  client: PublicClient,
  store: Address,
  hook: Address,
  includeResolvedUri = false,
) {
  const tiers: Awaited<ReturnType<typeof readTierPage>>[number][] = []
  const seen = new Set<number>()
  let startingId = 0n

  for (;;) {
    const page = await readTierPage(client, store, hook, startingId, includeResolvedUri)
    if (page.length === 0) break
    if (startingId !== 0n && BigInt(page[0].id) !== startingId) {
      throw new Error('The shop changed while its inventory was being read.')
    }
    const fresh = startingId === 0n ? page : page.slice(1)
    for (const tier of fresh) {
      if (seen.has(tier.id)) {
        throw new Error(`The shop repeated tier ${tier.id} while loading.`)
      }
      seen.add(tier.id)
      tiers.push(tier)
    }
    if (fresh.length < TIER_PAGE_SIZE) break
    const next = BigInt(fresh[fresh.length - 1].id)
    if (next === startingId) {
      throw new Error('The shop returned a cyclic inventory cursor.')
    }
    startingId = next
  }
  return tiers
}

type CategoryTier = { id: number; category: number }
type CategoryMedia = Readonly<Record<number, { categoryName?: string }>> | undefined

function categoryNameOf(tiers: readonly CategoryTier[], media: CategoryMedia, id: number) {
  const named = tiers.find(tier => tier.category === id && media?.[tier.id]?.categoryName)
  return named && media?.[named.id]?.categoryName
}

/** Every category a shop has, labelled from its items' metadata. */
export function shopCategories(tiers: readonly CategoryTier[], media: CategoryMedia) {
  const ids = [...new Set(tiers.map(tier => tier.category))].sort((a, b) => a - b)
  return ids.map(id => ({
    id,
    name: categoryNameOf(tiers, media, id) || (id === 0 ? 'General' : `Category ${id}`),
  }))
}

/**
 * The categories worth a filter chip. A number no metadata names tells a shopper nothing, and its
 * items stay under All. An item whose metadata failed to load proves nothing, so its category keeps
 * its chip until it does. General only reads as a choice beside a category that has a name.
 */
export function shopCategoryChips(
  tiers: readonly CategoryTier[],
  media: CategoryMedia,
  mediaFailed: boolean,
) {
  const categories = shopCategories(tiers, media)
  if (categories.length < 2) return []
  const real = ({ id }: { id: number }) =>
    !!categoryNameOf(tiers, media, id) ||
    (mediaFailed && tiers.some(tier => tier.category === id && !media?.[tier.id]))
  if (!categories.some(real)) return []
  return categories.filter(category => category.id === 0 || real(category))
}

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
      BigInt(startingId === 0n ? TIER_PAGE_SIZE : TIER_PAGE_SIZE + 1),
    ],
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

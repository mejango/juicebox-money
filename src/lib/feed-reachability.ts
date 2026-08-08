import type { JBChainId } from '@bananapus/nana-sdk-core'
import { probeFeedReachability as sdkProbeFeedReachability } from '@bananapus/nana-sdk-core/v6'
import { type PublicClient } from 'viem'
import {
  requiredFeedPairs,
  type AccountingConfig,
  type FeedPair,
  type LaunchPlan,
} from '@/lib/launch'
import { chainName } from '@/lib/urn'

/** A pair JBPrices proved it cannot resolve on one chain. */
export type MissingFeed = { chainId: number; aLabel: string; bLabel: string }

/**
 * The launch guard's verdict. Anything other than `ok` blocks the launch —
 * `missing` because the chain answered that a required feed pair does not
 * exist, `unavailable` because at least one probe couldn't be completed
 * (an RPC failure is not proof of a missing feed, but it's not proof of a
 * present one either, so it still fails closed with retry copy).
 */
export type FeedReachability =
  | { status: 'ok' }
  | { status: 'missing'; missing: MissingFeed[] }
  | { status: 'unavailable' }

/**
 * Probe on-chain that every JBPrices pair a launch plan needs
 * ({@link requiredFeedPairs}) resolves on every selected chain, via the SDK's
 * `probeFeedReachability` — the same `pricePerUnitOf` read the terminal
 * performs at runtime, at project id 0 for the protocol-default-feed
 * semantics a freshly launched project starts with (so a later default-feed
 * registration unblocks launches with no client release).
 *
 * The SDK probes one chain at a time and reports pairs, not chains; this fans
 * out across the selection and re-attaches the chain and the denomination
 * labels the block copy names. A chain with no client is `unavailable` for
 * the same reason the SDK reports a transport failure that way: not knowing
 * is not proof of a feed.
 */
export async function probeFeedReachability(args: {
  accounting: AccountingConfig
  issuanceBase: LaunchPlan['issuanceBase']
  chains: number[]
  getClient: (chainId: number) => Pick<PublicClient, 'readContract'> | null
}): Promise<FeedReachability> {
  const perChain = args.chains
    .map(chainId => ({
      chainId,
      pairs: requiredFeedPairs(
        args.accounting,
        args.issuanceBase,
        chainId as JBChainId,
      ),
    }))
    .filter(({ pairs }) => pairs.length > 0)
  if (perChain.length === 0) return { status: 'ok' }

  let unverified = false
  const missing: MissingFeed[] = []
  const results = await Promise.all(
    perChain.map(async ({ chainId, pairs }) => {
      const client = args.getClient(chainId)
      if (!client) return { chainId, pairs, verdict: null }
      return {
        chainId,
        pairs,
        verdict: await sdkProbeFeedReachability(client as PublicClient, {
          chainId: chainId as JBChainId,
          pairs,
        }),
      }
    }),
  )
  for (const { chainId, pairs, verdict } of results) {
    if (!verdict || verdict.status === 'unavailable') {
      unverified = true
      continue
    }
    if (verdict.status === 'ok') continue
    for (const pair of verdict.missing) {
      const labelled = pairs.find(
        candidate =>
          candidate.pricingCurrency === pair.pricingCurrency &&
          candidate.unitCurrency === pair.unitCurrency,
      ) as FeedPair
      missing.push({
        chainId,
        aLabel: labelled.aLabel,
        bLabel: labelled.bLabel,
      })
    }
  }
  if (missing.length > 0) return { status: 'missing', missing }
  if (unverified) return { status: 'unavailable' }
  return { status: 'ok' }
}

/**
 * Why this plan cannot be launched from here, or null when it can.
 *
 * Fails CLOSED: contexts are baked into the terminal forever at launch, so a
 * feed-less combination ships a project whose payments and cash outs revert —
 * permanently for revnets, whose stages can never allow adding feeds.
 */
export function feedReachabilityBlock(
  result: FeedReachability | null,
  revnet: boolean,
): string | null {
  if (!result || result.status === 'ok') return null
  if (result.status === 'unavailable') {
    return "Couldn't verify price feeds right now — check your connection and retry."
  }
  // The same token pair can be missing through several currency pairs
  // (context↔base and context↔context); collapse to one line per token
  // pair, naming every affected chain.
  const chainsByPair = new Map<string, number[]>()
  for (const m of result.missing) {
    const key = [m.aLabel, m.bLabel].sort().join(' and ')
    const chains = chainsByPair.get(key) ?? []
    if (!chains.includes(m.chainId)) chains.push(m.chainId)
    chainsByPair.set(key, chains)
  }
  const parts = [...chainsByPair]
    .map(
      ([pairLabel, chains]) =>
        `${pairLabel} on ${chains.map(chainName).join(', ')}`,
    )
    .join('; ')
  return (
    `No onchain price feed links ${parts}, so payments and cash outs would revert. ` +
    `Accept only one of these tokens for now — launching unblocks automatically once the protocol registers the missing feed.` +
    (revnet
      ? " A revnet's accepted tokens are permanent, so this could never be fixed after launch."
      : '')
  )
}

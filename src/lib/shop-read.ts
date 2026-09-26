import {
  JBOmnichainDeployerContracts,
  bytes32ToCidV0,
  jb721TiersHookStoreAbi,
  jbContractAddress,
  jbOmnichainDeployerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  BASE_CURRENCY_ETH,
  BASE_CURRENCY_USD,
  decode721RulesetMetadata,
  getAccountingContexts,
  getAllRulesets,
  getCurrentRuleset,
  getProject721Shop,
} from '@bananapus/nana-sdk-core/v6'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import type { Shop, ShopTier, TierMedia } from '@/hooks/useShop721'
import { appIpfsUrl } from '@/lib/format'
import { readAllActiveTiers, readTierPage } from '@/lib/shop-tiers'
import {
  parseTierMetadataJson,
  pickTierMetadata,
  tierMediaAssetUrl,
  tierMediaImageUrl,
} from '@/lib/tier-metadata'
import { tokenSymbol } from '@/lib/token-symbol'

/** The project's 721 shop reads, loaded on demand by the useShop721 hooks and the Shop tab. */

const ZERO_BYTES32 = `0x${'0'.repeat(64)}`


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
export async function readShop(
  client: PublicClient,
  chainId: JBChainId,
  projectId: number,
  isRevnet: boolean,
  nativeSymbol: string,
): Promise<Shop | null> {
  const [identity, current, allRulesets] = await Promise.all([
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
    // Only a revnet's schedule is settled: its stages are queued at deployFor and no
    // revnet actor holds QUEUE_RULESETS. A plain project can still queue a ruleset that
    // changes the answer, so there it stays a statement about the current stage.
    isRevnet
      ? getAllRulesets(client, {
          chainId,
          projectId: BigInt(projectId),
          size: 50n,
        }).catch(() => null)
      : Promise.resolve(null),
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
    splitPercent: Number(tier.splitPercent),
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
    transferPauseByStage: allRulesets?.length
      ? [...allRulesets]
          // Oldest first, numbered the way the Rulesets tab numbers stages.
          .sort((left, right) => left.ruleset.start - right.ruleset.start)
          .map((entry, index) => ({
            stage: index + 1,
            paused: decode721RulesetMetadata(Number(entry.metadata.metadata ?? 0))
              .pauseTransfers,
          }))
      : null,
    pricing: { currency, decimals, symbol },
    tiers,
    configFlags,
  }
}

/** Resolve a tier's display metadata: the resolver's data URI first, then
 *  the tier's IPFS JSON. Best-effort — {} on any failure. */
export async function resolveTierMedia(tier: ShopTier): Promise<TierMedia> {
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

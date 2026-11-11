import { JB_CHAINS, jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  getAccountingContexts,
  getCurrentRuleset,
  getUpcomingRuleset,
  v6Address,
  type JBRulesetWithMetadata,
} from '@bananapus/nana-sdk-core/v6'
import { createPublicClient, isAddressEqual, zeroAddress, type PublicClient } from 'viem'
import { publicReadHeaders } from '@/lib/api-cache'
import { parseChainProject } from '@/lib/api-params'
import {
  basisPoints,
  billionthsToPct,
  cashOutTaxValue,
  formatDuration,
  formatTokenAmount,
} from '@/lib/format'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import { baseCurrencyLabel, tokenSymbol } from '@/lib/token-symbol'

export const dynamic = 'force-dynamic'

const units = {
  blockNumber: 'the block every value was read at',
  start: 'value is ISO 8601 UTC; raw is Unix seconds',
  duration: 'raw is seconds; 0 means the rules last until the owner changes them',
  tokensPerUnit:
    'value is tokens created per 1 unit of baseCurrency paid, before reservedPercent is taken out; raw has 18 decimals',
  issuanceCutPercent: 'how much tokensPerUnit drops each time duration elapses; raw is out of 1e9',
  baseCurrency: 'raw is the currency id: 1 is ETH, 2 is USD, anything else is an accepted token',
  reservedPercent: 'value is the share of new tokens that does not go to the payer; raw is out of 10,000',
  cashOutTax: 'value is 0 to 1, where 1 turns cash outs off; raw is out of 10,000',
  dataHook:
    'contract address or null; when dataHookUsedForPayments is true it can change what a payment receives',
}

type Labels = Parameters<typeof baseCurrencyLabel>[1]

/** One ruleset in the units the Rules tab shows, each beside its onchain value. */
const terms = ({ ruleset: r, metadata: m }: JBRulesetWithMetadata, labels: Labels) => ({
  rulesetId: r.id,
  cycleNumber: r.cycleNumber,
  start: { value: new Date(r.start * 1000).toISOString(), raw: r.start },
  duration: { value: formatDuration(r.duration, { zeroLabel: 'Not set' }), raw: r.duration },
  tokensPerUnit: { value: formatTokenAmount(r.weight, 18, 2), raw: r.weight.toString() },
  issuanceCutPercent: { value: billionthsToPct(r.weightCutPercent), raw: r.weightCutPercent },
  baseCurrency: { value: baseCurrencyLabel(m.baseCurrency, labels), raw: m.baseCurrency },
  reservedPercent: { value: basisPoints(m.reservedPercent), raw: m.reservedPercent },
  cashOutTax: { value: cashOutTaxValue(m.cashOutTaxRate), raw: m.cashOutTaxRate },
  paymentsPaused: m.pausePay,
  dataHook: isAddressEqual(m.dataHook, zeroAddress) ? null : m.dataHook,
  dataHookUsedForPayments: m.useDataHookForPay,
})

/** What a payment to this project gets now and, if rules are queued, next. */
export async function GET(request: Request) {
  const { chainId, projectId, ok } = parseChainProject(new URL(request.url).searchParams)
  const chain = JB_CHAINS[chainId as JBChainId]?.chain
  if (!ok || !Number.isSafeInteger(projectId) || !chain) {
    return Response.json({ error: 'A supported chainId and a projectId are required.' }, { status: 400 })
  }
  try {
    const client = createPublicClient({ chain, transport: jbCenterRpcTransport(chainId, 4_000) })
    const blockNumber = await client.getBlockNumber()
    // Every read below answers for this one block, as the SDK's deployment checker does.
    const snapshot = {
      ...client,
      readContract: (parameters: object) => client.readContract({ ...parameters, blockNumber } as never),
    } as PublicClient
    const project = { chainId: chainId as JBChainId, projectId: BigInt(projectId) }
    const [current, upcoming, owner] = await Promise.all([
      getCurrentRuleset(snapshot, project),
      getUpcomingRuleset(snapshot, project),
      snapshot
        .readContract({
          address: v6Address('JBProjects', project.chainId),
          abi: jbProjectsAbi,
          functionName: 'ownerOf',
          args: [project.projectId],
        })
        .catch((error: unknown) => error as Error),
    ])
    // The Rules tab's test for a queued change: a stored ruleset other than the live one.
    const shown = [
      current.ruleset.id !== 0 ? current : null,
      upcoming.ruleset.id !== 0 && upcoming.ruleset.id !== current.ruleset.id ? upcoming : null,
    ]
    if (!shown[0] && !shown[1]) {
      return Response.json({ error: 'No rules found for this project on this chain.' }, { status: 404 })
    }
    if (owner instanceof Error) throw owner
    // Only a token-priced ruleset needs the accepted tokens' symbols to name its base currency.
    const labels = shown.some(entry => entry && entry.metadata.baseCurrency > 2)
      ? await Promise.all(
          (await getAccountingContexts(snapshot, project)).map(async ctx => ({
            currency: ctx.currency,
            symbol: await tokenSymbol(snapshot, ctx.token, project),
          })),
        )
      : undefined
    return Response.json(
      {
        chainId,
        projectId,
        blockNumber: blockNumber.toString(),
        isRevnet: isAddressEqual(owner, v6Address('REVOwner', project.chainId)),
        current: shown[0] && terms(shown[0], labels),
        upcoming: shown[1] && terms(shown[1], labels),
        units,
      },
      // Terms change only when a ruleset starts or is queued; 30 seconds matches revnet.money's /api/stages.
      { headers: { ...publicReadHeaders, 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=86400' } },
    )
  } catch {
    return Response.json({ error: 'Terms are unavailable. Retry shortly.' }, { status: 502 })
  }
}

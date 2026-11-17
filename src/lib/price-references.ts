import {
  JBCoreContracts,
  NATIVE_TOKEN,
  jbControllerAbi,
  jbTerminalStoreAbi,
  jbV6ContractAddress,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import type { Address, PublicClient } from 'viem'
import type { BsRevnetPriceHistory } from '@/lib/bendystraw'
import {
  accountingContextsQuery,
  controllerQuery,
  currentRulesetQuery,
  type ProjectDisplayReader,
} from '@/lib/project-display-queries'
import { tokenSymbolQuery } from '@/lib/token-symbol'

/** How often the price charts read again: the live references and the indexed history alike. */
export const PRICE_REFRESH_MS = 30_000

/** One cadence for the floor history and the rates that price it, so new moments never meet a stale rate. */
export const HISTORY_REFRESH = {
  staleTime: 30_000,
  refetchInterval: PRICE_REFRESH_MS,
  refetchOnWindowFocus: true,
  retry: 1,
}

/** The read behind `['revnetPriceHistory', suckerGroupId]`, the one key every chart of a group shares. */
export function priceHistoryRead(suckerGroupId: string | null, chainId: number) {
  return {
    enabled: !!suckerGroupId,
    ...HISTORY_REFRESH,
    queryFn: async (): Promise<BsRevnetPriceHistory> => {
      // chainId is an endpoint-routing hint (testnet groups live on the
      // testnet indexer); it never filters the group.
      const response = await fetch(
        `/api/price-history?suckerGroupId=${encodeURIComponent(suckerGroupId!)}&chainId=${chainId}`,
      )
      if (!response.ok) throw new Error('Price history is unavailable.')
      return response.json() as Promise<BsRevnetPriceHistory>
    },
  }
}

/**
 * One deployment's share of the cash out floor. The ruleset, accounting
 * contexts, controller and token symbol come from the shared display cache;
 * the supply and the surplus, which move with every payment, are read fresh
 * in one multicall. The symbol of a token the project accepts stays out of
 * that call, so a token that reverts cannot fail the protocol reads.
 */
export async function readPriceReferenceRow(
  client: PublicClient,
  reader: ProjectDisplayReader,
  chainId: JBChainId,
  projectId: bigint,
) {
  const store = jbV6ContractAddress[JBCoreContracts.JBTerminalStore][chainId] as
    | Address
    | undefined
  if (!store) throw new Error(`V6 contracts unavailable on ${chainId}`)

  const project = { chainId, projectId }
  const [contexts, currentRuleset, controller] = await Promise.all([
    reader.fetchQuery(accountingContextsQuery(client, project)),
    reader.fetchQuery(currentRulesetQuery(client, project)),
    reader.fetchQuery(controllerQuery(client, project)),
  ])
  const context = contexts[0]
  if (!context) throw new Error(`No accounting context on ${chainId}`)

  const [[supply, balance], contextSymbol] = await Promise.all([
    client.multicall({
      allowFailure: false,
      contracts: [
        {
          address: controller,
          abi: jbControllerAbi,
          functionName: 'totalTokenSupplyWithReservedTokensOf',
          args: [projectId],
        },
        {
          address: store,
          abi: jbTerminalStoreAbi,
          functionName: 'currentSurplusOf',
          args: [
            projectId,
            [],
            [],
            BigInt(context.decimals),
            BigInt(context.currency),
          ],
        },
      ],
    }),
    reader.fetchQuery(tokenSymbolQuery(client, context.token, chainId)),
  ])

  return {
    chainId,
    supply,
    balance,
    decimals: context.decimals,
    /** Accounting-context currency, for the base-currency axis conversion. */
    currency: Number(context.currency),
    baseCurrency: Number(currentRuleset.metadata.baseCurrency),
    contextSymbol,
    isNative: context.token.toLowerCase() === NATIVE_TOKEN.toLowerCase(),
    cashOutTaxRate: currentRuleset.metadata.cashOutTaxRate,
    scopeLocal: currentRuleset.metadata.scopeCashOutsToLocalBalances,
  }
}

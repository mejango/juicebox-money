/**
 * Adapter from the indexed movement row used by this app to the SDK's
 * on-chain, root-verified sucker movement and claim primitives.
 */
import {
  claimFromSuckerMovement,
  getAccountingContexts,
  getSuckerMovements,
  suckerBytes32ToAddress,
  type JBClaim,
} from '@bananapus/nana-sdk-core/v6'
import {
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { isAddressEqual, type Address, type PublicClient } from 'viem'
import type { BridgeMovement } from '@/lib/suckers-queries'

function accountingAssetKey(
  token: Address,
  chainId: JBChainId,
  decimals: number,
): string {
  if (isAddressEqual(token, NATIVE_TOKEN)) return `native@${decimals}`
  if (isAddressEqual(token, USDC_ADDRESSES[chainId])) {
    return `usdc@${decimals}`
  }
  return `${token.toLowerCase()}@${decimals}`
}

export async function buildClaim(
  sourceClient: PublicClient,
  destinationClient: PublicClient,
  indexed: BridgeMovement,
  projects?: {
    sourceProjectId: bigint
    destinationProjectId: bigint
  },
): Promise<JBClaim> {
  let historicalRemoteToken: Address | undefined
  if (projects) {
    const sourceChainId = indexed.sourceChainId as JBChainId
    const destinationChainId = indexed.destChainId as JBChainId
    const [sourceContexts, destinationContexts] = await Promise.all([
      getAccountingContexts(sourceClient, {
        chainId: sourceChainId,
        projectId: projects.sourceProjectId,
      }),
      getAccountingContexts(destinationClient, {
        chainId: destinationChainId,
        projectId: projects.destinationProjectId,
      }),
    ])
    const sourceContext = sourceContexts.find(context =>
      isAddressEqual(context.token, indexed.token as Address),
    )
    if (sourceContext) {
      const sourceKey = accountingAssetKey(
        sourceContext.token,
        sourceChainId,
        sourceContext.decimals,
      )
      const candidates = destinationContexts.filter(
        context =>
          accountingAssetKey(
            context.token,
            destinationChainId,
            context.decimals,
          ) === sourceKey,
      )
      historicalRemoteToken =
        candidates.length === 1 ? candidates[0].token : undefined
    }
  }

  const movements = await getSuckerMovements(
    sourceClient,
    destinationClient,
    {
      sourceSucker: indexed.sourceSucker as Address,
      destinationSucker: indexed.destSucker as Address,
      sourceToken: indexed.token as Address,
      remoteToken: historicalRemoteToken,
    },
  )
  const movement = movements.find(
    candidate => candidate.leaf.index === BigInt(indexed.index),
  )
  if (!movement) throw new Error('This move is not in the sucker outbox.')

  // The indexer is only used to select a row. Refuse the claim if its visible
  // identity disagrees with the SDK's verified event preimage.
  if (
    !isAddressEqual(
      suckerBytes32ToAddress(movement.leaf.beneficiary),
      indexed.beneficiary as Address,
    ) ||
    movement.leaf.projectTokenCount !== BigInt(indexed.projectTokenCount) ||
    movement.leaf.terminalTokenAmount !== BigInt(indexed.terminalTokenAmount)
  ) {
    throw new Error(
      'The indexed bridge movement does not match its verified on-chain leaf.',
    )
  }

  return claimFromSuckerMovement(movement)
}

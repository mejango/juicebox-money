import { jbControllerAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'

export function buildBurnTokensRequest({
  chainId,
  controller,
  holder,
  projectId,
  tokenCount,
  memo,
}: {
  chainId: JBChainId
  controller: Address
  holder: Address
  projectId: bigint
  tokenCount: bigint
  memo: string
}) {
  if (tokenCount <= 0n) throw new Error('Burn amount must be greater than zero.')

  return {
    chainId,
    address: controller,
    abi: jbControllerAbi,
    functionName: 'burnTokensOf' as const,
    args: [holder, projectId, tokenCount, memo.trim()] as const,
  }
}

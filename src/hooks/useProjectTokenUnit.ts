'use client'

import {
  JBCoreContracts,
  jbContractAddress,
  jbTokensAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { erc20Abi, zeroAddress } from 'viem'
import { useReadContract } from 'wagmi'

/**
 * The word activity rows count a project's tokens in: the ERC-20 symbol once
 * a token is deployed, 'token credits' before one exists, and 'tokens' while
 * the address is still loading.
 */
export function useProjectTokenUnit(
  chainId: JBChainId,
  projectId: number,
): string {
  const { data: tokenAddress } = useReadContract({
    abi: jbTokensAbi,
    address: jbContractAddress['6'][JBCoreContracts.JBTokens][chainId],
    functionName: 'tokenOf',
    args: [BigInt(projectId)],
    chainId,
    query: { staleTime: 60_000 },
  })
  const deployed = !!tokenAddress && tokenAddress !== zeroAddress
  const { data: projectTokenSymbol } = useReadContract({
    abi: erc20Abi,
    address: tokenAddress as `0x${string}`,
    functionName: 'symbol',
    chainId,
    query: { enabled: deployed, staleTime: 60_000 },
  })
  return projectTokenSymbol
    ? String(projectTokenSymbol)
    : tokenAddress === zeroAddress
      ? 'token credits'
      : 'tokens'
}

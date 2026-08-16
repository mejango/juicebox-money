'use client'

import { useMemo } from 'react'
import type { Address } from 'viem'
import { erc20Abi } from 'viem'
import { useAccount, useBalance, useReadContracts } from 'wagmi'

/**
 * The connected wallet's balance of several tokens on one chain, in one read.
 *
 * `useTokenBalance` answers for one token, which cannot answer "can this wallet pay at all" —
 * that needs every token a project accepts, and a hook cannot be called in a loop.
 *
 * Keyed to the CONNECTED account rather than the viewed one, for the same reason its
 * single-token sibling is: a payment spends the wallet that signs it, so "view as" must not
 * change what this reports.
 */
export function useTokenBalances(
  tokens: { address: Address; isNative: boolean }[],
  chainId: number,
): { balances: Map<string, bigint>; isLoading: boolean } {
  const { address } = useAccount()

  const erc20Tokens = useMemo(
    () => tokens.filter(token => !token.isNative),
    [tokens],
  )

  const contracts = useMemo(
    () =>
      erc20Tokens.map(token => ({
        chainId,
        abi: erc20Abi,
        address: token.address,
        functionName: 'balanceOf' as const,
        args: address ? ([address] as const) : undefined,
      })),
    [erc20Tokens, address, chainId],
  )

  const { data: erc20Data, isLoading: erc20Loading } = useReadContracts({
    contracts,
    query: {
      enabled: !!address && contracts.length > 0,
      refetchOnMount: false,
    },
  })

  const hasNative = tokens.some(token => token.isNative)
  const { data: nativeData, isLoading: nativeLoading } = useBalance({
    address,
    chainId,
    query: { enabled: !!address && hasNative, refetchOnMount: false },
  })

  const balances = useMemo(() => {
    const map = new Map<string, bigint>()
    erc20Tokens.forEach((token, index) => {
      const result = erc20Data?.[index]?.result
      if (typeof result === 'bigint') map.set(token.address, result)
    })
    const native = tokens.find(token => token.isNative)
    if (native && nativeData?.value != null) {
      map.set(native.address, nativeData.value)
    }
    return map
  }, [tokens, erc20Tokens, erc20Data, nativeData])

  return { balances, isLoading: erc20Loading || nativeLoading }
}

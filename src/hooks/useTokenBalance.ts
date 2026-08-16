'use client'

import type { Address } from 'viem'
import { erc20Abi } from 'viem'
import { useAccount, useBalance, useReadContract } from 'wagmi'

/**
 * The connected wallet's balance of one token on one chain, native and ERC-20
 * behind one shape so callers don't branch.
 *
 * Deliberately keyed to the *connected* account rather than the viewed one:
 * a payment always spends the wallet that signs it, so "view as" must not
 * change what this reports.
 */
export function useTokenBalance({
  token,
  chainId,
  isNative,
  enabled = true,
}: {
  token: Address | undefined
  chainId: number
  isNative: boolean
  enabled?: boolean
}): { balance: bigint | undefined; isLoading: boolean } {
  const { address } = useAccount()
  const on = enabled && !!address

  const native = useBalance({
    address,
    chainId,
    query: { enabled: on && isNative, refetchOnMount: false },
  })

  const erc20 = useReadContract({
    chainId,
    abi: erc20Abi,
    address: token,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: on && !isNative && !!token, refetchOnMount: false },
  })

  return isNative
    ? { balance: native.data?.value, isLoading: native.isLoading }
    : { balance: erc20.data, isLoading: erc20.isLoading }
}

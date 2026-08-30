import {
  JB_CHAINS,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { truncateAddress } from '@/lib/format'

/**
 * Read a token's display symbol: the chain's native symbol for the
 * NATIVE_TOKEN sentinel, else the ERC-20 `symbol()` with a truncated address
 * as the fallback for tokens that don't speak it. Pass `nativeSymbol` when
 * it's already resolved, or `chainId` to look it up from JB_CHAINS.
 */
export async function tokenSymbol(
  client: PublicClient,
  token: Address,
  opts: { chainId?: JBChainId; nativeSymbol?: string } = {},
): Promise<string> {
  if (token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
    return (
      opts.nativeSymbol ??
      (opts.chainId !== undefined
        ? JB_CHAINS[opts.chainId]?.nativeTokenSymbol
        : undefined) ??
      'ETH'
    )
  }
  // Known USDC needs no read. When the `symbol()` call fails (a blocked RPC), the truncated
  // address below never matches "USDC", and the pay panel then tells a USDC project's payer to
  // buy ETH.
  if (
    Object.values(USDC_ADDRESSES).some(
      usdc => usdc?.toLowerCase() === token.toLowerCase(),
    )
  )
    return 'USDC'
  return client
    .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
    .then(s => s as string)
    .catch(() => truncateAddress(token))
}

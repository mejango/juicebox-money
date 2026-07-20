import {
  JB_CHAINS,
  NATIVE_TOKEN,
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
  return client
    .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
    .then(s => s as string)
    .catch(() => truncateAddress(token))
}

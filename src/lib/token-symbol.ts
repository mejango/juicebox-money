import {
  JB_CHAINS,
  NATIVE_TOKEN,
  USDC_ADDRESSES,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { erc20Abi, type Address, type PublicClient } from 'viem'
import { truncateAddress } from '@/lib/format'

/**
 * A token's symbol when it needs no read: the chain's native symbol for the
 * NATIVE_TOKEN sentinel, "USDC" for a known USDC deployment, else null.
 */
export function knownTokenSymbol(
  token: string,
  opts: { chainId?: number; nativeSymbol?: string } = {},
): string | null {
  if (token.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
    return (
      opts.nativeSymbol ??
      (opts.chainId !== undefined
        ? JB_CHAINS[opts.chainId as JBChainId]?.nativeTokenSymbol
        : undefined) ??
      'ETH'
    )
  }
  // When the `symbol()` call fails (a blocked RPC), the truncated address never matches
  // "USDC", and the pay panel then tells a USDC project's payer to buy ETH.
  if (
    opts.chainId !== undefined &&
    USDC_ADDRESSES[opts.chainId as JBChainId]?.toLowerCase() === token.toLowerCase()
  )
    return 'USDC'
  return null
}

/**
 * Read a token's display symbol: `knownTokenSymbol`, else the ERC-20
 * `symbol()` with a truncated address as the fallback for tokens that don't
 * speak it. Pass `nativeSymbol` when it's already resolved, or `chainId` to
 * look it up from JB_CHAINS.
 */
export async function tokenSymbol(
  client: PublicClient,
  token: Address,
  opts: { chainId?: JBChainId; nativeSymbol?: string } = {},
): Promise<string> {
  const known = knownTokenSymbol(token, { ...opts, chainId: opts.chainId ?? client.chain?.id })
  if (known) return known
  return client
    .readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
    .then(s => s as string)
    .catch(() => truncateAddress(token))
}

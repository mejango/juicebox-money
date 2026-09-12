import { jbContractAddress } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'
import { rolloutChain } from '@/lib/protocol-rollout'

// The address book isn't uniformly indexable by every contract enum or chain
// id (some contracts/chains are absent), so read it through one cast point.
const V6_ADDRESSES = jbContractAddress['6'] as Record<
  string,
  Record<number, string | undefined>
>

/** A V6 contract address by name, or undefined when absent on the chain. */
export function addrOf(name: string, chainId: number): Address | undefined {
  const rollout = rolloutChain(chainId)?.contracts as Record<string, string | null> | undefined
  if (rollout && Object.hasOwn(rollout, name)) return (rollout[name] ?? undefined) as Address | undefined
  return V6_ADDRESSES[name]?.[chainId] as Address | undefined
}

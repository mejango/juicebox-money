import { jbRouterTerminalRegistryAbi } from '@bananapus/nana-sdk-core'
import { getAddress, isAddressEqual, type Address, type PublicClient } from 'viem'
import { contractReverted } from '@/lib/errors'
import { rolloutAddress, rolloutChain } from '@/lib/protocol-rollout'

/** Recorded payment entries, including direct routers retained by older projects. */
export function knownPaymentRouterEntries(chainId: number): Address[] {
  const record = rolloutChain(chainId)
  const addresses = [
    rolloutAddress('JBRouterTerminalRegistry', chainId),
    rolloutAddress('JBRouterTerminalGateway', chainId),
    rolloutAddress('JBRouterTerminal', chainId),
    ...Object.values(record?.history.JBRouterTerminal ?? {}),
  ].filter((address): address is string => !!address)
  return [...new Set(addresses.map(address => address.toLowerCase()))].map(address => getAddress(address))
}

/** Preserve the listed entry; a direct gateway/router does not imply an attached registry. */
export function attachedPaymentRouterEntries(chainId: number, terminals: readonly Address[]): Address[] {
  return knownPaymentRouterEntries(chainId)
    .map(known => terminals.find(terminal => isAddressEqual(known, terminal)))
    .filter((terminal): terminal is Address => !!terminal)
}

/** Find an attached entry with a live route for this token without bypassing its gateway. */
export async function readPaymentRouterEntry(
  client: Pick<PublicClient, 'readContract'>,
  {
    chainId,
    projectId,
    terminals,
    token,
    decimals,
  }: {
    chainId: number
    projectId: bigint
    terminals: readonly Address[]
    token: Address
    decimals: number
  },
): Promise<Address | null> {
  for (const terminal of attachedPaymentRouterEntries(chainId, terminals)) {
    try {
      const [ruleset] = await client.readContract({
        address: terminal,
        abi: jbRouterTerminalRegistryAbi,
        functionName: 'previewPayFor',
        args: [projectId, token, 10n ** BigInt(decimals), '0x0000000000000000000000000000000000000001', '0x'],
      })
      if (BigInt(ruleset.id) !== 0n) return terminal
    } catch (error) {
      // A contract revert means this entry cannot route the token. An RPC error
      // leaves its state unknown and must not select a different payment route.
      if (!contractReverted(error)) throw error
    }
  }
  return null
}

import { jbDirectoryAbi, jbRouterTerminalRegistryAbi } from '@bananapus/nana-sdk-core'
import { getAddress, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import snapshot from './protocol-rollout.json'
import { routerGatewayAbi } from './router-gateway-abi'

type ContractName = keyof (typeof snapshot.chains)['1']['contracts']
type ChainRecord = {
  alias: string
  contracts: Record<ContractName, string | null>
  history: Record<string, { previous: string | null; v1: string | null }>
}

export function rolloutChain(chainId: number): ChainRecord | undefined {
  return (snapshot.chains as Record<string, ChainRecord>)[chainId]
}

export function rolloutAddress(name: ContractName, chainId: number): Address | null {
  const address = rolloutChain(chainId)?.contracts[name]
  return address ? getAddress(address) : null
}

export function rolloutTargets(chainId: number): { hook: Address; terminal: Address } | null {
  const hook = rolloutAddress('JBBuybackHook', chainId)
  const terminal = rolloutAddress('JBRouterTerminalGateway', chainId)
  return hook && terminal ? { hook, terminal } : null
}

/** Retired deployments remain recognizable even while a project still selects them. */
export function rolloutContractName(chainId: number, address: Address): string | null {
  const chain = rolloutChain(chainId)
  if (!chain) return null
  for (const [name, generations] of Object.entries(chain.history)) {
    for (const [generation, deployed] of Object.entries(generations)) {
      if (deployed && isAddressEqual(deployed as Address, address)) return `${name} (${generation})`
    }
  }
  for (const [name, deployed] of Object.entries(chain.contracts)) {
    if (deployed && isAddressEqual(deployed as Address, address)) return `${name} (current)`
  }
  return null
}

export type RouterPath = { registry: Address; terminal: Address; gateway: Address | null; router: Address | null }

/** Resolve the project's actual selection; rollout defaults do not migrate projects. */
export async function readRouterPath(client: PublicClient, chainId: number, projectId: bigint): Promise<RouterPath | null> {
  const registry = rolloutAddress('JBRouterTerminalRegistry', chainId)
  const directory = rolloutAddress('JBDirectory', chainId)
  if (!registry || !directory) return null
  const attached = await client.readContract({ address: directory, abi: jbDirectoryAbi, functionName: 'isTerminalOf', args: [projectId, registry] })
  if (!attached) return null
  const terminal = await client.readContract({ address: registry, abi: jbRouterTerminalRegistryAbi, functionName: 'terminalOf', args: [projectId] })
  if (isAddressEqual(terminal, zeroAddress)) return null
  const knownGateway = rolloutAddress('JBRouterTerminalGateway', chainId)
  const gateway = knownGateway && isAddressEqual(terminal, knownGateway) ? terminal : null
  // A failed gateway read is unknown; never show its address as the underlying router.
  const knownRouter = [rolloutAddress('JBRouterTerminal', chainId), ...Object.values(rolloutChain(chainId)?.history.JBRouterTerminal ?? {})]
    .some(address => address && isAddressEqual(address as Address, terminal))
  const router = gateway
    ? await client.readContract({ address: gateway, abi: routerGatewayAbi, functionName: 'ROUTER' }).catch(() => null)
    : knownRouter ? terminal : null
  return { registry, terminal, gateway, router }
}

export const RETAINED_FEE_NOTE = 'Eligible failed fee routes stay in the gateway for retry. They are not settled payments or forgiven fees. A successful retry settles the route; a qualified finalization can return funds to the source project.'
